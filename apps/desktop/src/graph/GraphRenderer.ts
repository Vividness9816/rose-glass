/* Canvas-2D living-graph renderer — physics + draw ported from the mockup
   (vaultforge-design.html update() 992-1026 + draw() 1028-1164), as a
   self-contained class. All colors come from the resolved GraphTheme; no
   hex literals, no module globals. This is the §20 canvas-2D fallback leg;
   the WebGPU primary renderer (later phase) becomes the second caller and
   the point an extracted Renderer interface earns its place. */

import type { GraphData, GraphEdge, GraphNode } from './types';
import { type GraphTheme, rgba } from './themeColors';

/** Graph-field opacity over the §21 living backdrop. 1 = opaque (backdrop hidden),
    lower = more motion bleeds through. The user's visibility dial for Phase 6. */
const GRAPH_BG_ALPHA = 0.4;

interface Particle {
  e: GraphEdge;
  t: number;
  speed: number;
}

function midpoint(na: GraphNode, nb: GraphNode, i: number, j: number) {
  return {
    mx: (na.x + nb.x) / 2 + Math.sin(i * 1.7 + j) * 18,
    my: (na.y + nb.y) / 2 + Math.cos(j * 1.3 + i) * 14,
  };
}

export class GraphRenderer {
  private ctx: CanvasRenderingContext2D;
  private data: GraphData;
  private theme: GraphTheme;
  private particles: Particle[] = [];
  private W = 0; // logical (CSS) px — the backing store is W*dpr × H*dpr physical px
  private H = 0;
  private dpr = 1;
  private tick = 0;
  private raf = 0;
  private running = false;

  constructor(canvas: HTMLCanvasElement, data: GraphData, theme: GraphTheme, dpr = 1) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.data = data;
    this.theme = theme;
    this.dpr = dpr;
    // GraphPane sizes the backing store to physical px (w*dpr); work in logical px.
    this.W = canvas.width / dpr;
    this.H = canvas.height / dpr;
    this.data.edges.forEach((e) => {
      for (let i = 0; i < 2; i++) this.spawnParticle(e);
    });
  }

  setTheme(theme: GraphTheme) {
    this.theme = theme;
  }

  setSize(w: number, h: number, dpr = this.dpr) {
    this.dpr = dpr;
    this.W = w;
    this.H = h;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.update();
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private spawnParticle(e: GraphEdge) {
    this.particles.push({ e, t: Math.random(), speed: 0.003 + Math.random() * 0.004 });
  }

  private update() {
    this.tick++;
    const { nodes } = this.data;
    nodes.forEach((n) => {
      n.vx += (Math.random() - 0.5) * 0.04;
      n.vy += (Math.random() - 0.5) * 0.04;
      // cohesion toward the live centroid of cluster mates (resize-safe)
      const mates = nodes.filter((m) => m.cluster === n.cluster && m.id !== n.id);
      if (mates.length) {
        const avgx = mates.reduce((s, m) => s + m.x, 0) / mates.length;
        const avgy = mates.reduce((s, m) => s + m.y, 0) / mates.length;
        n.vx += (avgx - n.x) * 0.003;
        n.vy += (avgy - n.y) * 0.003;
      }
      // collision / repulsion
      nodes.forEach((m) => {
        if (m.id === n.id) return;
        const dx = n.x - m.x;
        const dy = n.y - m.y;
        const d2 = dx * dx + dy * dy;
        const minD = 22 + n.r + m.r;
        if (d2 < minD * minD && d2 > 0.01) {
          const d = Math.sqrt(d2);
          n.vx += (dx / d) * (minD - d) * 0.12;
          n.vy += (dy / d) * (minD - d) * 0.12;
        }
      });
      n.vx *= 0.88;
      n.vy *= 0.88;
      n.x += n.vx;
      n.y += n.vy;
      const pad = 30;
      if (n.x < pad) n.vx += 0.3;
      if (n.x > this.W - pad) n.vx -= 0.3;
      if (n.y < pad) n.vy += 0.3;
      if (n.y > this.H - pad) n.vy -= 0.3;
      n.phase += 0.02;
    });
    this.particles = this.particles.filter((p) => {
      p.t += p.speed * p.e.flow;
      if (p.t > 1 || p.t < 0) {
        this.spawnParticle(p.e);
        return false;
      }
      return true;
    });
  }

  private draw() {
    const { ctx, W, H, theme } = this;
    const { nodes, edges } = this.data;
    const clusterRgb = (c: number) => theme.clusters[c]?.rgb ?? theme.clusters[0].rgb;

    // Map logical → physical px so all draws (incl. text) render at native resolution
    // (crisp on HiDPI/4K — fixes the canvas-at-CSS-px fuzziness). Reset+scale each frame.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // ponytail: translucent (was opaque theme.bg) so the §21 living backdrop shows
    // through behind the graph — the graph floats in the gradient field. The alpha keeps
    // node/edge contrast; lower it to reveal more motion, raise it to mute the backdrop.
    ctx.fillStyle = rgba(theme.bgRgb, GRAPH_BG_ALPHA);
    ctx.fillRect(0, 0, W, H);

    // ambient radial wash (cluster 0 + 1 hues)
    const ag = ctx.createRadialGradient(W * 0.45, H * 0.45, 0, W * 0.45, H * 0.45, W * 0.45);
    ag.addColorStop(0, rgba(clusterRgb(0), 0.06));
    ag.addColorStop(0.5, rgba(clusterRgb(1), 0.03));
    ag.addColorStop(1, 'transparent');
    ctx.fillStyle = ag;
    ctx.fillRect(0, 0, W, H);

    // slime trails — faint links between nearby same-cluster nodes
    nodes.forEach((n, i) => {
      nodes.slice(i + 1).forEach((m, j) => {
        if (n.cluster !== m.cluster) return;
        if (Math.hypot(n.x - m.x, n.y - m.y) > 140) return;
        const { mx, my } = midpoint(n, m, i, i + j + 1);
        ctx.beginPath();
        ctx.moveTo(n.x, n.y);
        ctx.quadraticCurveTo(mx, my, m.x, m.y);
        ctx.strokeStyle = rgba(clusterRgb(n.cluster), 0.06);
        ctx.lineWidth = 8;
        ctx.stroke();
      });
    });

    // cluster auras
    nodes.forEach((n) => {
      if (n.links < 1) return;
      const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 50);
      g.addColorStop(0, rgba(clusterRgb(n.cluster), 0.1));
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 50, 0, Math.PI * 2);
      ctx.fill();
    });

    // edges
    edges.forEach((e) => {
      const na = nodes[e.a];
      const nb = nodes[e.b];
      if (!na || !nb) return;
      const isCross = na.cluster !== nb.cluster;
      const { mx, my } = midpoint(na, nb, e.a, e.b);
      const col = isCross ? theme.crossEdge : clusterRgb(na.cluster);
      ctx.beginPath();
      ctx.moveTo(na.x, na.y);
      ctx.quadraticCurveTo(mx, my, nb.x, nb.y);
      ctx.strokeStyle = rgba(col, isCross ? 0.18 : 0.15 + e.trail * 0.2);
      ctx.lineWidth = 0.6 + e.trail * 1.5;
      ctx.stroke();
      if (e.trail > 0.25) {
        ctx.beginPath();
        ctx.moveTo(na.x, na.y);
        ctx.quadraticCurveTo(mx, my, nb.x, nb.y);
        ctx.strokeStyle = rgba(col, isCross ? 0.3 : e.trail * 0.35);
        ctx.lineWidth = 0.3;
        ctx.stroke();
      }
      if (e.trail > 0.15) {
        const t = 0.88;
        const px = (1 - t) * (1 - t) * na.x + 2 * (1 - t) * t * mx + t * t * nb.x;
        const py = (1 - t) * (1 - t) * na.y + 2 * (1 - t) * t * my + t * t * nb.y;
        const ang = Math.atan2(nb.y - py, nb.x - px);
        ctx.beginPath();
        ctx.moveTo(nb.x - Math.cos(ang - 0.45) * 6, nb.y - Math.sin(ang - 0.45) * 6);
        ctx.lineTo(nb.x, nb.y);
        ctx.lineTo(nb.x - Math.cos(ang + 0.45) * 6, nb.y - Math.sin(ang + 0.45) * 6);
        ctx.strokeStyle = rgba(col, isCross ? 0.4 : e.trail * 0.5);
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    });

    // tributary particles
    this.particles.forEach((p) => {
      const na = nodes[p.e.a];
      const nb = nodes[p.e.b];
      if (!na || !nb) return;
      if (Math.hypot(na.x - nb.x, na.y - nb.y) > 160) return;
      const { mx, my } = midpoint(na, nb, p.e.a, p.e.b);
      const t = p.t;
      const x = (1 - t) * (1 - t) * na.x + 2 * (1 - t) * t * mx + t * t * nb.x;
      const y = (1 - t) * (1 - t) * na.y + 2 * (1 - t) * t * my + t * t * nb.y;
      const isCross = na.cluster !== nb.cluster;
      ctx.beginPath();
      ctx.arc(x, y, 1.3, 0, Math.PI * 2);
      ctx.fillStyle = rgba(isCross ? theme.crossEdge : clusterRgb(na.cluster), 0.8);
      ctx.fill();
    });

    // nodes
    nodes.forEach((n) => {
      const rgbC = clusterRgb(n.cluster);
      const accent = theme.clusters[n.cluster]?.accent ?? theme.clusters[0].accent;
      const pulse = Math.sin(n.phase) * 0.5 + 0.5;

      if (n.hub) {
        for (let r = 3; r >= 1; r--) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r * (1.4 + r * 0.65) + pulse * 4, 0, Math.PI * 2);
          ctx.strokeStyle = rgba(rgbC, 0.03 + 0.03 * r);
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 2.8 + pulse * 3);
        g.addColorStop(0, rgba(rgbC, 0.45));
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * 2.8 + pulse * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = theme.nodeCore;
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * 0.38, 0, Math.PI * 2);
        ctx.fillStyle = rgba(rgbC, 0.93);
        ctx.fill();
        for (let i = 0; i < Math.min(n.links, 5); i++) {
          const a = (i / 5) * Math.PI * 2 + this.tick * 0.015;
          const dr = n.r + 9 + pulse * 2;
          ctx.beginPath();
          ctx.arc(n.x + Math.cos(a) * dr, n.y + Math.sin(a) * dr, 1.4, 0, Math.PI * 2);
          ctx.fillStyle = rgba(rgbC, 0.6);
          ctx.fill();
        }
        ctx.font = 'bold 10px Inter, sans-serif';
        ctx.fillStyle = rgba(theme.label, 0.85);
        ctx.textAlign = 'center';
        ctx.fillText(n.name, n.x, n.y + n.r + 14);
        ctx.textAlign = 'left';
      } else if (n.links >= 2) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 2 + pulse * 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(rgbC, 0.12 + pulse * 0.12);
        ctx.lineWidth = 0.8;
        ctx.stroke();
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 1.8);
        g.addColorStop(0, rgba(rgbC, 0.22));
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = theme.nodeCore;
        ctx.fill();
        ctx.strokeStyle = rgba(rgbC, 0.8);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(n.x - n.r * 0.25, n.y - n.r * 0.25, n.r * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = rgba(rgbC, 0.4 + pulse * 0.5);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = theme.nodeCore;
        ctx.fill();
        ctx.strokeStyle = rgba(rgbC, 0.2);
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    });
  }
}
