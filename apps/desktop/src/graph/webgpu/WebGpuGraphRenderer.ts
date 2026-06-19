/* Phase 4 — WebGPU graph renderer (the §6/§11.3 primary path; canvas-2D is the
   fallback). It renders the SAME rich look as the canvas-2D `GraphRenderer`
   (cluster auras / node glow, curved quadratic edges + arrowheads + trails,
   tributary particles, hub rings + orbiting dots, the theme bullseye inversion,
   Focus dimming, and CC activity flares) by replaying the 2D path's exact CPU
   formulas into three instanced GPU pipelines:

     • sprite — a unit quad, instanced; per-instance softness picks a HARD disc
       (cores / particles / orbit dots / highlights) vs a SOFT radial glow
       (auras / ambient wash / flare fills); a screen-space flag fixes the wash
       to the viewport (matches the 2D screen-space wash).
     • ring   — a unit quad, instanced; an annulus SDF for hub rings, the mid
       ring, the accent strokes, and the flare rings.
     • ribbon — CPU-tessellated triangle ribbons (see ribbon.ts, unit-tested) for
       the curved edges / trails / slime / arrowheads (WebGPU has no curve
       primitive and line-list is a hardware-1px line).
     • label  — a textured quad per hub sampling a lazily-built label atlas (the
       hub names rasterized once via canvas-2D into one texture, see labelAtlas.ts;
       white coverage tinted to the theme label colour in the fragment, so a theme
       flip needs no atlas rebuild).

   Layout + interaction are identical to the 2D path (shared Camera / hitTest /
   seedable stepSimulation), and the look is now at full parity (hub text labels
   included).

   SAFETY (§17 / ADR-20260616): `create()` is the ONLY constructor and returns
   `null` on ANY init failure (no adapter/device, pipeline validation error, lost
   context) — the caller then keeps the proven canvas-2D renderer. A WebGPU bug can
   never blank or break the graph; worst case the GPU toggle is a no-op. All GPU
   work in `frame()` is guarded: an external device loss surfaces as a throw →
   stop + onLost → GraphPane rebuilds on canvas-2D. */

import type { GraphData, GraphEdge, GraphNode } from '../types';
import type { GraphTheme, RGB } from '../themeColors';
import type { GraphRendererLike } from '../Renderer';
import { type Camera, IDENTITY_CAMERA, panBy, screenToWorld, zoomAt } from '../camera';
import { nodeAtWorld } from '../hitTest';
import { stepSimulation } from '../simulation';
import { DEFAULT_CONFIG, type GraphConfig } from '../config';
import { indexNodesByPath, lookupNodeByRel } from '../GraphRenderer';
import { RIBBON_STRIDE, ribbonInto, sampleQuadratic, type RGB01, type Vec2 } from './ribbon';
import { layoutLabelAtlas } from './labelAtlas';

const GRAPH_BG_ALPHA = 0.4; // matches the canvas-2D path (lets the §21 backdrop bleed through)

const SPRITE_STRIDE = 9; // cx,cy, radius, r,g,b, alpha, soft, screen
const RING_STRIDE = 8; //   cx,cy, radius, width, r,g,b, alpha
const LABEL_STRIDE = 9; //  cx,cy, halfW,halfH, uvOffX,uvOffY, uvScaleX,uvScaleY, dim
const SEG_EDGE = 12; // bezier segments per edge ribbon
const SEG_SLIME = 5; // bezier segments per slime ribbon
const LABEL_FONT_PX = 10; // matches the 2D hub label `bold 10px Inter`
// ponytail: 4× supersample. The atlas is rasterized ONCE (not per-zoom like the 2D
// fillText), so labels are crisp at typical zoom and soften only past ~4× magnification —
// a deliberate trade (a cheap static atlas vs per-frame text). Raise for more zoom headroom.
const LABEL_SCALE = 4;
const LABEL_GAP = 6; // world-px gap below the node (tuned to the 2D baseline placement)
const LABEL_ALPHA = 0.85; // matches the 2D `rgba(theme.label, 0.85)`

/** GPU handles for the hub-label pass, created once in create() (under the error scope).
    The atlas TEXTURE + its bind group are built lazily (they need runtime canvas text
    measurement) and live as mutable fields. */
interface LabelGpu {
  pipeline: GPURenderPipeline;
  bgl: GPUBindGroupLayout;
  sampler: GPUSampler;
  colUB: GPUBuffer;
  vb: GPUBuffer;
}

interface LabelMeta {
  uvOff: [number, number];
  uvScale: [number, number];
  worldW: number;
  worldH: number;
}

interface Particle {
  e: GraphEdge;
  t: number;
  speed: number;
}

/** Per-frame buffer capacities, derived from graph size. The slime layer is the
    only O(n²) source (same as the 2D path); cap the ribbon count so a dense vault
    can't grow the buffer unbounded. ponytail: dropped slime is invisible (alpha
    0.06); raise SLIME_MAX if a huge vault visibly thins. */
function caps(data: GraphData) {
  const N = data.nodes.length;
  const E = data.edges.length;
  const slimeMax = N * 4;
  return {
    spriteCap: N * 11 + E * 2 + 8,
    ringCap: N * 5 + 8,
    slimeMax,
    // edge ribbons: (base + trail) × SEG_EDGE + a 2-seg arrowhead, ×6 verts/seg
    ribbonVertCap: E * (SEG_EDGE * 2 * 6 + 2 * 6) + slimeMax * (SEG_SLIME * 6) + 6,
  };
}

const SHADER = /* wgsl */ `
struct Cam { z: vec4<f32>, v: vec4<f32> };       // z=(zoom,tx,ty,_), v=(W,H,_,_)
@group(0) @binding(0) var<uniform> cam: Cam;

fn screenToClip(s: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(s.x / cam.v.x * 2.0 - 1.0, 1.0 - s.y / cam.v.y * 2.0);
}
fn worldToClip(w: vec2<f32>) -> vec2<f32> {
  return screenToClip(w * cam.z.x + cam.z.yz);  // world -> screen (CSS px) -> clip
}

// ── sprite: soft radial glow (soft>0.5) or hard AA disc ──
struct SpriteOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) col: vec3<f32>,
  @location(2) a: f32,
  @location(3) soft: f32,
};
@vertex
fn vs_sprite(
  @location(0) corner: vec2<f32>, @location(1) center: vec2<f32>, @location(2) radius: f32,
  @location(3) col: vec3<f32>, @location(4) alpha: f32, @location(5) soft: f32, @location(6) screen: f32,
) -> SpriteOut {
  var o: SpriteOut;
  let p = center + corner * radius;
  let clip = select(worldToClip(p), screenToClip(p), screen > 0.5);
  o.pos = vec4<f32>(clip, 0.0, 1.0);
  o.local = corner; o.col = col; o.a = alpha; o.soft = soft;
  return o;
}
@fragment
fn fs_sprite(@location(0) local: vec2<f32>, @location(1) col: vec3<f32>, @location(2) alpha: f32, @location(3) soft: f32) -> @location(0) vec4<f32> {
  let d = length(local);
  if (d > 1.0) { discard; }
  let hard = alpha * smoothstep(1.0, 0.82, d);   // AA-edged solid disc
  let glow = alpha * (1.0 - d);                   // linear radial falloff (matches the 2D gradients)
  let a = select(hard, glow, soft > 0.5);
  return vec4<f32>(col * a, a);                    // premultiplied alpha
}

// ── ring: annulus SDF (hub rings / mid ring / accent strokes / flare rings) ──
struct RingOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) col: vec3<f32>,
  @location(2) a: f32,
  @location(3) rNorm: f32,
  @location(4) hwNorm: f32,
};
@vertex
fn vs_ring(
  @location(0) corner: vec2<f32>, @location(1) center: vec2<f32>, @location(2) radius: f32,
  @location(3) width: f32, @location(4) col: vec3<f32>, @location(5) alpha: f32,
) -> RingOut {
  var o: RingOut;
  let ro = radius + width;                         // inflate the quad to hold the full stroke
  o.pos = vec4<f32>(worldToClip(center + corner * ro), 0.0, 1.0);
  o.local = corner; o.col = col; o.a = alpha;
  o.rNorm = radius / ro;
  o.hwNorm = max(0.5 * width / ro, 0.0008);
  return o;
}
@fragment
fn fs_ring(@location(0) local: vec2<f32>, @location(1) col: vec3<f32>, @location(2) alpha: f32, @location(3) rNorm: f32, @location(4) hwNorm: f32) -> @location(0) vec4<f32> {
  let d = length(local);
  let a = alpha * (1.0 - smoothstep(0.0, hwNorm, abs(d - rNorm)));
  if (a <= 0.0) { discard; }
  return vec4<f32>(col * a, a);
}

// ── ribbon: pre-tessellated curved edges / slime / arrowheads ──
struct RibbonOut { @builtin(position) pos: vec4<f32>, @location(0) col: vec3<f32>, @location(1) a: f32 };
@vertex
fn vs_ribbon(@location(0) wp: vec2<f32>, @location(1) col: vec3<f32>, @location(2) alpha: f32) -> RibbonOut {
  var o: RibbonOut;
  o.pos = vec4<f32>(worldToClip(wp), 0.0, 1.0);
  o.col = col; o.a = alpha;
  return o;
}
@fragment
fn fs_ribbon(@location(0) col: vec3<f32>, @location(1) alpha: f32) -> @location(0) vec4<f32> {
  return vec4<f32>(col * alpha, alpha);
}

// ── label: a textured quad per hub, sampling the (white-coverage) label atlas and
//    tinting to the theme label colour. The atlas is theme-independent (coverage only),
//    so a theme flip only rewrites labelCol — no atlas rebuild. ──
struct LabelOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) dim: f32 };
@vertex
fn vs_label(
  @location(0) corner: vec2<f32>, @location(1) center: vec2<f32>, @location(2) half: vec2<f32>,
  @location(3) uvOff: vec2<f32>, @location(4) uvScale: vec2<f32>, @location(5) dim: f32,
) -> LabelOut {
  var o: LabelOut;
  o.pos = vec4<f32>(worldToClip(center + corner * half), 0.0, 1.0);
  o.uv = uvOff + (corner * 0.5 + vec2<f32>(0.5, 0.5)) * uvScale;
  o.dim = dim;
  return o;
}
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var atlasSamp: sampler;
@group(0) @binding(3) var<uniform> labelCol: vec4<f32>;  // rgb = theme label, a = master alpha
@fragment
fn fs_label(@location(0) uv: vec2<f32>, @location(1) dim: f32) -> @location(0) vec4<f32> {
  let cov = textureSample(atlasTex, atlasSamp, uv).a;   // glyph coverage (white, premultiplied)
  let a = cov * labelCol.a * dim;                         // × focus dim (matches 2D nodeAlpha)
  if (a <= 0.0) { discard; }
  return vec4<f32>(labelCol.rgb * a, a);                  // premultiplied, tinted
}
`;

type DrawOp = { p: 'sprite' | 'ring' | 'ribbon'; first: number; count: number };

export class WebGpuGraphRenderer implements GraphRendererLike {
  private camera: Camera = IDENTITY_CAMERA;
  private draggingId: number | null = null;
  private theme: GraphTheme;
  private config: GraphConfig = DEFAULT_CONFIG; // v2.0 user-tunable physics
  private W: number;
  private H: number;
  private dpr: number;
  private raf = 0;
  private running = false;
  private tick = 0;
  private particles: Particle[] = [];
  private pulses = new Map<number, { kind: 'read' | 'modify'; t: number }>();
  private pathIndex: { exact: Map<string, GraphNode>; lower: Map<string, GraphNode> };
  private byId = new Map<number, GraphNode>();
  private focusSet: Set<number> | null = null;
  private lostFired = false; // one-shot: external loss can arrive via frame() AND device.lost
  // per-frame scene buffers (CPU side; reused — no per-frame allocation)
  private spriteData: Float32Array;
  private ringData: Float32Array;
  private ribbonData: Float32Array;
  private spriteCap: number;
  private ringCap: number;
  private slimeMax: number; // cached cap on faint O(n²) slime ribbons (computed once)
  // hub labels (lazily-built atlas; the GPU handles arrive via `label`)
  private labelData: Float32Array;
  private labelCap: number;
  private labelBuilt = false; // build the atlas once on the first frame
  private atlasTex: GPUTexture | null = null;
  private labelBind: GPUBindGroup | null = null;
  private labelMeta = new Map<string, LabelMeta>();

  private constructor(
    canvas: HTMLCanvasElement,
    private data: GraphData,
    theme: GraphTheme,
    dpr: number,
    private device: GPUDevice,
    private ctx: GPUCanvasContext,
    private spritePipeline: GPURenderPipeline,
    private ringPipeline: GPURenderPipeline,
    private ribbonPipeline: GPURenderPipeline,
    private camUB: GPUBuffer,
    private camBind: GPUBindGroup,
    private quadVB: GPUBuffer,
    private spriteVB: GPUBuffer,
    private ringVB: GPUBuffer,
    private ribbonVB: GPUBuffer,
    private label: LabelGpu,
    private onLost: (() => void) | undefined,
  ) {
    this.theme = theme;
    this.dpr = dpr;
    this.W = canvas.width / dpr;
    this.H = canvas.height / dpr;
    this.pathIndex = indexNodesByPath(data.nodes);
    data.nodes.forEach((n) => this.byId.set(n.id, n));
    data.edges.forEach((e) => {
      for (let i = 0; i < 2; i++) this.spawnParticle(e);
    });
    const c = caps(data);
    this.spriteCap = c.spriteCap;
    this.ringCap = c.ringCap;
    this.slimeMax = c.slimeMax;
    this.spriteData = new Float32Array(Math.max(1, c.spriteCap) * SPRITE_STRIDE);
    this.ringData = new Float32Array(Math.max(1, c.ringCap) * RING_STRIDE);
    this.ribbonData = new Float32Array(Math.max(1, c.ribbonVertCap) * RIBBON_STRIDE);
    this.labelCap = data.nodes.filter((n) => n.hub).length;
    this.labelData = new Float32Array(Math.max(1, this.labelCap) * LABEL_STRIDE);
    // External device loss (GPU reset / TDR) → fall back to canvas-2D. Registered here
    // (not in create()) so it shares the one-shot `lostFired` with the frame() catch path;
    // our own teardown (reason 'destroyed') is ignored.
    void this.device.lost.then((info) => {
      if (info.reason !== 'destroyed') this.fireLost();
    });
  }

  /** Signal external device loss to the caller exactly once (frame() catch and the
      device.lost promise can both fire for the same loss). */
  private fireLost() {
    if (this.lostFired) return;
    this.lostFired = true;
    this.onLost?.();
  }

  /** Build the renderer, or return null on ANY failure (caller falls back to 2D).
      `onLost` fires on EXTERNAL device loss (GPU reset / TDR) so the caller can
      rebuild on canvas-2D — our own teardown (reason 'destroyed') is ignored. */
  static async create(
    canvas: HTMLCanvasElement,
    data: GraphData,
    theme: GraphTheme,
    dpr: number,
    onLost?: () => void,
  ): Promise<WebGpuGraphRenderer | null> {
    let device: GPUDevice | undefined;
    try {
      const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      device = await adapter.requestDevice();
      // device.lost is wired in the constructor (so it shares the one-shot loss guard).
      const ctx = canvas.getContext('webgpu');
      if (!ctx) {
        device.destroy();
        return null;
      }
      const format = gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: 'premultiplied' });

      // One error-scope pair around ALL resource creation (pipelines AND buffers) so the
      // "create() returns null on ANY init failure" contract also covers an over-limit
      // buffer (a huge vault) — it pops as a validation/OOM error → clean 2D fallback,
      // not a first-frame device-loss surprise.
      device.pushErrorScope('out-of-memory');
      device.pushErrorScope('validation');
      const module = device.createShaderModule({ code: SHADER });
      const bgl = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
      });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
      const blend: GPUBlendState = {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      };
      const quadLayout: GPUVertexBufferLayout = {
        arrayStride: 8,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
      };
      const spritePipeline = device.createRenderPipeline({
        layout,
        vertex: {
          module,
          entryPoint: 'vs_sprite',
          buffers: [
            quadLayout,
            {
              arrayStride: SPRITE_STRIDE * 4,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 1, offset: 0, format: 'float32x2' }, // center
                { shaderLocation: 2, offset: 8, format: 'float32' }, // radius
                { shaderLocation: 3, offset: 12, format: 'float32x3' }, // col
                { shaderLocation: 4, offset: 24, format: 'float32' }, // alpha
                { shaderLocation: 5, offset: 28, format: 'float32' }, // soft
                { shaderLocation: 6, offset: 32, format: 'float32' }, // screen
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fs_sprite', targets: [{ format, blend }] },
        primitive: { topology: 'triangle-strip' },
      });
      const ringPipeline = device.createRenderPipeline({
        layout,
        vertex: {
          module,
          entryPoint: 'vs_ring',
          buffers: [
            quadLayout,
            {
              arrayStride: RING_STRIDE * 4,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 1, offset: 0, format: 'float32x2' }, // center
                { shaderLocation: 2, offset: 8, format: 'float32' }, // radius
                { shaderLocation: 3, offset: 12, format: 'float32' }, // width
                { shaderLocation: 4, offset: 16, format: 'float32x3' }, // col
                { shaderLocation: 5, offset: 28, format: 'float32' }, // alpha
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fs_ring', targets: [{ format, blend }] },
        primitive: { topology: 'triangle-strip' },
      });
      const ribbonPipeline = device.createRenderPipeline({
        layout,
        vertex: {
          module,
          entryPoint: 'vs_ribbon',
          buffers: [
            {
              arrayStride: RIBBON_STRIDE * 4,
              stepMode: 'vertex',
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' }, // pos
                { shaderLocation: 1, offset: 8, format: 'float32x3' }, // col
                { shaderLocation: 2, offset: 20, format: 'float32' }, // alpha
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fs_ribbon', targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
      });
      // label: textured quad (cam + atlas texture + sampler + tint uniform)
      const labelBgl = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ],
      });
      const labelPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [labelBgl] }),
        vertex: {
          module,
          entryPoint: 'vs_label',
          buffers: [
            quadLayout,
            {
              arrayStride: LABEL_STRIDE * 4,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 1, offset: 0, format: 'float32x2' }, // center
                { shaderLocation: 2, offset: 8, format: 'float32x2' }, // half-extent
                { shaderLocation: 3, offset: 16, format: 'float32x2' }, // uv offset
                { shaderLocation: 4, offset: 24, format: 'float32x2' }, // uv scale
                { shaderLocation: 5, offset: 32, format: 'float32' }, // focus dim
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fs_label', targets: [{ format, blend }] },
        primitive: { topology: 'triangle-strip' },
      });
      const labelSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      const labelColUB = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const camUB = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const camBind = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: camUB } }] });
      const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
      const quadVB = device.createBuffer({ size: quad.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(quadVB, 0, quad);

      // Per-frame scene buffers. The edge terms (sprite/ribbon) scale linearly with edge
      // count and are NOT capped (the 2D path draws every edge too — a cap would silently
      // drop edges). A pathologically large vault that exceeds the device buffer limit pops
      // the error scope below → null → clean canvas-2D fallback. Only slime (faint, O(n²))
      // is count-capped (slimeMax), since it would otherwise dominate the buffer.
      const c = caps(data);
      const dev = device; // narrowed const for the closure (let `device` loses narrowing)
      const mk = (floats: number) =>
        dev.createBuffer({
          size: Math.max(16, floats * 4),
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      const spriteVB = mk(c.spriteCap * SPRITE_STRIDE);
      const ringVB = mk(c.ringCap * RING_STRIDE);
      const ribbonVB = mk(c.ribbonVertCap * RIBBON_STRIDE);
      const labelVB = mk(Math.max(1, data.nodes.filter((n) => n.hub).length) * LABEL_STRIDE);

      const vErr = await device.popErrorScope(); // validation (LIFO: inner scope first)
      const oErr = await device.popErrorScope(); // out-of-memory
      if (vErr || oErr) {
        device.destroy(); // shader/pipeline/buffer init failed → release + fall back to 2D
        return null;
      }

      const label: LabelGpu = { pipeline: labelPipeline, bgl: labelBgl, sampler: labelSampler, colUB: labelColUB, vb: labelVB };
      return new WebGpuGraphRenderer(
        canvas, data, theme, dpr, device, ctx,
        spritePipeline, ringPipeline, ribbonPipeline,
        camUB, camBind, quadVB, spriteVB, ringVB, ribbonVB, label, onLost,
      );
    } catch {
      try {
        device?.destroy();
      } catch {
        /* already lost */
      }
      return null;
    }
  }

  setTheme(theme: GraphTheme) {
    this.theme = theme;
  }
  setConfig(config: GraphConfig) {
    this.config = config;
  }
  setSize(w: number, h: number, dpr = this.dpr) {
    this.dpr = dpr;
    this.W = w;
    this.H = h;
  }
  getCamera(): Camera {
    return this.camera;
  }
  zoomAtScreen(sx: number, sy: number, factor: number) {
    this.camera = zoomAt(this.camera, sx, sy, factor);
  }
  panByScreen(dx: number, dy: number) {
    this.camera = panBy(this.camera, dx, dy);
  }
  pickAtScreen(sx: number, sy: number, slack = 5): GraphNode | undefined {
    const [wx, wy] = screenToWorld(this.camera, sx, sy);
    return nodeAtWorld(this.data.nodes, wx, wy, slack / this.camera.zoom);
  }
  moveNodeToScreen(id: number, sx: number, sy: number) {
    const n = this.byId.get(id);
    if (!n) return;
    const [wx, wy] = screenToWorld(this.camera, sx, sy);
    n.x = wx;
    n.y = wy;
    n.vx = 0;
    n.vy = 0;
  }
  setDragging(id: number | null) {
    this.draggingId = id;
  }
  pulse(rel: string, action: 'read' | 'modify') {
    const n = lookupNodeByRel(this.pathIndex, rel);
    if (n) this.pulses.set(n.id, { kind: action, t: 1 });
  }

  /** Local-graph focus: dim everything except `path`'s node + its 1-hop neighbours
      (same logic + id↔index invariant as the canvas-2D path). `null`/unknown clears. */
  setFocus(path: string | null) {
    if (!path) {
      this.focusSet = null;
      return;
    }
    const n = lookupNodeByRel(this.pathIndex, path);
    if (!n) {
      this.focusSet = null;
      return;
    }
    const set = new Set<number>([n.id]);
    for (const e of this.data.edges) {
      if (e.a === n.id) set.add(e.b);
      else if (e.b === n.id) set.add(e.a);
    }
    this.focusSet = set;
  }

  private spawnParticle(e: GraphEdge) {
    this.particles.push({ e, t: Math.random(), speed: 0.003 + Math.random() * 0.004 });
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    // Release GPU resources — GraphPane discards + rebuilds on teardown/toggle (the instance
    // is single-use; it is never start()ed again after stop()), so a non-destroying stop would
    // leak a device per toggle. We destroy the buffers + atlas texture explicitly; the sampler /
    // bind-group(-layout) / pipeline / texture-view have no destroy() in WebGPU and are reclaimed
    // by device.destroy() below.
    try {
      this.spriteVB.destroy();
      this.ringVB.destroy();
      this.ribbonVB.destroy();
      this.quadVB.destroy();
      this.camUB.destroy();
      this.label.vb.destroy();
      this.label.colUB.destroy();
      this.atlasTex?.destroy();
      this.device.destroy();
    } catch {
      /* already released / context lost */
    }
  }

  /** True once the bold Inter face is loaded (or the Font Loading API is unavailable), so
      the atlas isn't rasterized in a fallback font on the very first frame. */
  private fontReady(): boolean {
    try {
      return !document.fonts || document.fonts.check(`bold ${LABEL_FONT_PX * LABEL_SCALE}px Inter`);
    } catch {
      return true;
    }
  }

  /** Rasterize the hub label strings into ONE atlas texture (white coverage on
      transparent, tinted in the fragment) and cache each label's UV rect + world size.
      Built once on the first frame (the hub set is static per renderer instance).
      BEST-EFFORT + non-fatal: empty names are dropped, and if the packed atlas would
      exceed the device texture limit it is SKIPPED (labels just don't show) rather than
      built as an invalid texture — WebGPU surfaces such errors asynchronously, so they
      would otherwise escape frame()'s catch and spew per-frame validation errors. The
      graph keeps rendering on the GPU either way. */
  private buildLabelAtlas() {
    this.labelBuilt = true;
    const labels = [
      ...new Set(this.data.nodes.filter((n) => n.hub).map((n) => n.name).filter((s) => s.trim().length > 0)),
    ];
    if (!labels.length) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const font = `bold ${LABEL_FONT_PX * LABEL_SCALE}px Inter, sans-serif`;
    ctx.font = font;
    const lineH = Math.ceil(LABEL_FONT_PX * LABEL_SCALE * 1.4);
    const metrics = labels.map((text) => ({ text, w: Math.ceil(ctx.measureText(text).width) + 2, h: lineH }));
    const { atlasW, atlasH, rects } = layoutLabelAtlas(metrics, 2048, 2);
    // Skip rather than build an over-limit (invalid) texture — the failure would surface
    // asynchronously, past frame()'s try/catch. Labels are optional; the graph is unaffected.
    const maxDim = this.device.limits.maxTextureDimension2D;
    if (atlasW > maxDim || atlasH > maxDim) return;
    canvas.width = atlasW;
    canvas.height = atlasH;
    ctx.font = font; // resizing the canvas resets the 2D context — re-apply
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (const r of rects) ctx.fillText(r.text, r.x, r.y);

    const tex = this.device.createTexture({
      size: [atlasW, atlasH],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: tex, premultipliedAlpha: true }, [atlasW, atlasH]);
    this.atlasTex?.destroy();
    this.atlasTex = tex;
    this.labelBind = this.device.createBindGroup({
      layout: this.label.bgl,
      entries: [
        { binding: 0, resource: { buffer: this.camUB } },
        { binding: 1, resource: tex.createView() },
        { binding: 2, resource: this.label.sampler },
        { binding: 3, resource: { buffer: this.label.colUB } },
      ],
    });
    this.labelMeta.clear();
    for (const r of rects) {
      this.labelMeta.set(r.text, {
        uvOff: [r.x / atlasW, r.y / atlasH],
        uvScale: [r.w / atlasW, r.h / atlasH],
        worldW: r.w / LABEL_SCALE,
        worldH: r.h / LABEL_SCALE,
      });
    }
  }

  private n01(v: RGB): RGB01 {
    return [v[0] / 255, v[1] / 255, v[2] / 255];
  }
  private clusterRgb01(c: number): RGB01 {
    return this.n01(this.theme.clusters[c]?.rgb ?? this.theme.clusters[0].rgb);
  }
  private nodeFocusA(id: number): number {
    return this.focusSet && !this.focusSet.has(id) ? 0.12 : 1;
  }
  private edgeFocusA(a: number, b: number): number {
    return this.focusSet && !this.focusSet.has(a) && !this.focusSet.has(b) ? 0.08 : 1;
  }

  /** Assemble the frame's geometry into the three reusable CPU arrays, returning the
      ordered draw ops (back→front) so the layering matches the immediate-mode 2D
      path. Sprite/ring/ribbon sub-ranges are filled in draw order, so each op's
      range is contiguous in its buffer. */
  private buildScene(): { ops: DrawOp[]; spriteN: number; ringN: number; ribbonF: number } {
    const { theme } = this;
    const { nodes, edges } = this.data;
    const sprite = this.spriteData;
    const ring = this.ringData;
    const ribbon = this.ribbonData;
    let sN = 0;
    let rN = 0;
    let bF = 0; // ribbon float cursor
    const ops: DrawOp[] = [];

    const addSprite = (cx: number, cy: number, radius: number, col: RGB01, alpha: number, soft: number, screen: number) => {
      if (sN >= this.spriteCap || alpha <= 0 || radius <= 0) return;
      const o = sN * SPRITE_STRIDE;
      sprite[o] = cx; sprite[o + 1] = cy; sprite[o + 2] = radius;
      sprite[o + 3] = col[0]; sprite[o + 4] = col[1]; sprite[o + 5] = col[2];
      sprite[o + 6] = alpha; sprite[o + 7] = soft; sprite[o + 8] = screen;
      sN++;
    };
    const addRing = (cx: number, cy: number, radius: number, width: number, col: RGB01, alpha: number) => {
      if (rN >= this.ringCap || alpha <= 0 || radius <= 0) return;
      const o = rN * RING_STRIDE;
      ring[o] = cx; ring[o + 1] = cy; ring[o + 2] = radius; ring[o + 3] = width;
      ring[o + 4] = col[0]; ring[o + 5] = col[1]; ring[o + 6] = col[2]; ring[o + 7] = alpha;
      rN++;
    };
    const ribbonQuad = (p0: Vec2, ctrl: Vec2, p1: Vec2, seg: number, hw: number, col: RGB01, alpha: number) => {
      if (alpha <= 0) return;
      bF = ribbonInto(ribbon, bF, sampleQuadratic(p0, ctrl, p1, seg), hw, col, alpha);
    };
    const ribbonPoly = (pts: Vec2[], hw: number, col: RGB01, alpha: number) => {
      if (alpha <= 0) return;
      bF = ribbonInto(ribbon, bF, pts, hw, col, alpha);
    };
    const layerSprite = (fill: () => void) => {
      const start = sN;
      fill();
      if (sN > start) ops.push({ p: 'sprite', first: start, count: sN - start });
    };
    const layerRing = (fill: () => void) => {
      const start = rN;
      fill();
      if (rN > start) ops.push({ p: 'ring', first: start, count: rN - start });
    };
    const layerRibbon = (fill: () => void) => {
      const start = bF;
      fill();
      const verts = (bF - start) / RIBBON_STRIDE;
      if (verts > 0) ops.push({ p: 'ribbon', first: start / RIBBON_STRIDE, count: verts });
    };

    const mid = (na: GraphNode, nb: GraphNode, i: number, j: number): Vec2 => ({
      x: (na.x + nb.x) / 2 + Math.sin(i * 1.7 + j) * 18,
      y: (na.y + nb.y) / 2 + Math.cos(j * 1.3 + i) * 14,
    });
    const crossEdge01 = this.n01(theme.crossEdge);
    const core01 = this.n01(theme.nodeCoreRgb);
    // bullseye inversion (theme-driven), mirroring the 2D path's rgbC/coreFill/accent
    const palette = (n: GraphNode) => {
      const cluster01 = this.clusterRgb01(n.cluster);
      const rgbC = theme.invertNodes ? core01 : cluster01; // shell: rings / aura / dots / strokes
      const coreFill = theme.invertNodes ? cluster01 : core01; // centre disc
      return { rgbC, coreFill }; // accent === rgbC (clusterAccent rgb == cluster rgb)
    };

    // 1 — ambient wash (screen-space soft). ponytail: one soft sprite approximates the
    //     2D path's 3-stop radial wash; it's a barely-there tint (alpha 0.06).
    layerSprite(() => addSprite(this.W * 0.45, this.H * 0.45, this.W * 0.45, this.clusterRgb01(0), 0.06, 1, 1));

    // 2 — slime trails (faint same-cluster proximity curves)
    let slimeLeft = this.slimeMax;
    layerRibbon(() => {
      for (let i = 0; i < nodes.length && slimeLeft > 0; i++) {
        const n = nodes[i];
        for (let j = i + 1; j < nodes.length && slimeLeft > 0; j++) {
          const m = nodes[j];
          if (n.cluster !== m.cluster) continue;
          if (Math.hypot(n.x - m.x, n.y - m.y) > 140) continue;
          const c = mid(n, m, i, j); // j is m's absolute index — matches 2D's `i + j_slice + 1`
          ribbonQuad({ x: n.x, y: n.y }, c, { x: m.x, y: m.y }, SEG_SLIME, 4, this.clusterRgb01(n.cluster), 0.06 * this.edgeFocusA(n.id, m.id));
          slimeLeft--;
        }
      }
    });

    // 3 — cluster auras (nodes with links≥1)
    layerSprite(() => {
      nodes.forEach((n) => {
        if (n.links < 1) return;
        addSprite(n.x, n.y, 50, this.clusterRgb01(n.cluster), 0.1 * this.nodeFocusA(n.id), 1, 0);
      });
    });

    // 4 — edges (curved base + trail overlay + arrowhead)
    layerRibbon(() => {
      edges.forEach((e) => {
        const na = nodes[e.a];
        const nb = nodes[e.b];
        if (!na || !nb) return;
        const fa = this.edgeFocusA(e.a, e.b);
        const isCross = na.cluster !== nb.cluster;
        const c = mid(na, nb, e.a, e.b);
        const col = isCross ? crossEdge01 : this.clusterRgb01(na.cluster);
        ribbonQuad({ x: na.x, y: na.y }, c, { x: nb.x, y: nb.y }, SEG_EDGE, (0.6 + e.trail * 1.5) / 2, col, (isCross ? 0.18 : 0.15 + e.trail * 0.2) * fa);
        if (e.trail > 0.25)
          ribbonQuad({ x: na.x, y: na.y }, c, { x: nb.x, y: nb.y }, SEG_EDGE, 0.15, col, (isCross ? 0.3 : e.trail * 0.35) * fa);
        if (e.trail > 0.15) {
          const t = 0.88;
          const px = (1 - t) * (1 - t) * na.x + 2 * (1 - t) * t * c.x + t * t * nb.x;
          const py = (1 - t) * (1 - t) * na.y + 2 * (1 - t) * t * c.y + t * t * nb.y;
          const ang = Math.atan2(nb.y - py, nb.x - px);
          ribbonPoly(
            [
              { x: nb.x - Math.cos(ang - 0.45) * 6, y: nb.y - Math.sin(ang - 0.45) * 6 },
              { x: nb.x, y: nb.y },
              { x: nb.x - Math.cos(ang + 0.45) * 6, y: nb.y - Math.sin(ang + 0.45) * 6 },
            ],
            0.4,
            col,
            (isCross ? 0.4 : e.trail * 0.5) * fa,
          );
        }
      });
    });

    // 5 — tributary particles (hard discs riding the edge beziers)
    layerSprite(() => {
      this.particles.forEach((p) => {
        const na = nodes[p.e.a];
        const nb = nodes[p.e.b];
        if (!na || !nb) return;
        if (Math.hypot(na.x - nb.x, na.y - nb.y) > 160) return;
        const c = mid(na, nb, p.e.a, p.e.b);
        const t = p.t;
        const x = (1 - t) * (1 - t) * na.x + 2 * (1 - t) * t * c.x + t * t * nb.x;
        const y = (1 - t) * (1 - t) * na.y + 2 * (1 - t) * t * c.y + t * t * nb.y;
        const isCross = na.cluster !== nb.cluster;
        addSprite(x, y, 1.3, isCross ? crossEdge01 : this.clusterRgb01(na.cluster), 0.8 * this.edgeFocusA(p.e.a, p.e.b), 0, 0);
      });
    });

    // 6 — nodes (rings behind → auras → cores+highlights → accent strokes → orbit dots).
    //     ponytail: batched per-pipeline within the node phase (not per-node) — identical
    //     for a non-overlapping graph (collision repulsion keeps minD spacing).
    const pulseOf = (n: GraphNode) => Math.sin(n.phase) * 0.5 + 0.5;
    layerRing(() => {
      nodes.forEach((n) => {
        const fa = this.nodeFocusA(n.id);
        const pulse = pulseOf(n);
        const { rgbC } = palette(n);
        if (n.hub) {
          for (let r = 3; r >= 1; r--) addRing(n.x, n.y, n.r * (1.4 + r * 0.65) + pulse * 4, 0.8, rgbC, (0.03 + 0.03 * r) * fa);
        } else if (n.links >= 2) {
          addRing(n.x, n.y, n.r + 2 + pulse * 2.5, 0.8, rgbC, (0.12 + pulse * 0.12) * fa);
        }
      });
    });
    layerSprite(() => {
      nodes.forEach((n) => {
        const fa = this.nodeFocusA(n.id);
        const pulse = pulseOf(n);
        const { rgbC } = palette(n);
        if (n.hub) addSprite(n.x, n.y, n.r * 2.8 + pulse * 3, rgbC, 0.45 * fa, 1, 0);
        else if (n.links >= 2) addSprite(n.x, n.y, n.r * 1.8, rgbC, 0.22 * fa, 1, 0);
      });
    });
    layerSprite(() => {
      nodes.forEach((n) => {
        const fa = this.nodeFocusA(n.id);
        const pulse = pulseOf(n);
        const { rgbC, coreFill } = palette(n);
        addSprite(n.x, n.y, n.r, coreFill, fa, 0, 0);
        if (n.hub) addSprite(n.x, n.y, n.r * 0.38, rgbC, 0.93 * fa, 0, 0);
        else if (n.links >= 2) addSprite(n.x - n.r * 0.25, n.y - n.r * 0.25, n.r * 0.28, rgbC, (0.4 + pulse * 0.5) * fa, 0, 0);
      });
    });
    layerRing(() => {
      nodes.forEach((n) => {
        const fa = this.nodeFocusA(n.id);
        const { rgbC } = palette(n);
        if (n.hub) addRing(n.x, n.y, n.r, 1.5, rgbC, fa);
        else if (n.links >= 2) addRing(n.x, n.y, n.r, 1, rgbC, 0.8 * fa);
        else addRing(n.x, n.y, n.r, 0.5, rgbC, 0.2 * fa);
      });
    });
    layerSprite(() => {
      nodes.forEach((n) => {
        if (!n.hub) return;
        const fa = this.nodeFocusA(n.id);
        const pulse = pulseOf(n);
        const { rgbC } = palette(n);
        const count = Math.min(n.links, 5);
        for (let i = 0; i < count; i++) {
          const a = (i / 5) * Math.PI * 2 + this.tick * 0.015;
          const dr = n.r + 9 + pulse * 2;
          addSprite(n.x + Math.cos(a) * dr, n.y + Math.sin(a) * dr, 1.4, rgbC, 0.6 * fa, 0, 0);
        }
      });
    });

    // 7 — CC activity flares (overlay, full strength — ignore focus dimming, like 2D)
    const read01 = this.n01(theme.activityRead);
    const modify01 = this.n01(theme.activityModify);
    layerSprite(() => {
      this.pulses.forEach((p, id) => {
        const n = this.byId.get(id);
        if (!n) return;
        addSprite(n.x, n.y, n.r + 6 + (1 - p.t) * 22, p.kind === 'read' ? read01 : modify01, 0.5 * p.t, 1, 0);
      });
    });
    layerRing(() => {
      this.pulses.forEach((p, id) => {
        const n = this.byId.get(id);
        if (!n) return;
        addRing(n.x, n.y, n.r + 6 + (1 - p.t) * 22, 2, p.kind === 'read' ? read01 : modify01, 0.7 * p.t);
      });
    });

    return { ops, spriteN: sN, ringN: rN, ribbonF: bF };
  }

  private frame() {
    const { data } = this;
    // shared layout + drag pin (identical to the 2D path)
    const drag = this.draggingId !== null ? data.nodes.find((n) => n.id === this.draggingId) : undefined;
    const px = drag?.x;
    const py = drag?.y;
    this.tick++;
    stepSimulation(data.nodes, this.W, this.H, undefined, this.config);
    if (drag && px !== undefined && py !== undefined) {
      drag.x = px;
      drag.y = py;
      drag.vx = 0;
      drag.vy = 0;
    }
    // tributary particles: advance, respawn at the ends (same as the 2D update)
    this.particles = this.particles.filter((p) => {
      p.t += p.speed * p.e.flow;
      if (p.t > 1 || p.t < 0) {
        this.spawnParticle(p.e);
        return false;
      }
      return true;
    });
    this.pulses.forEach((p, id) => {
      p.t *= 0.95;
      if (p.t < 0.02) this.pulses.delete(id);
    });

    // ALL GPU work is guarded: an external device loss surfaces here as a throw
    // (e.g. getCurrentTexture) → stop + onLost → GraphPane rebuilds on canvas-2D.
    try {
      // Build the atlas once Inter is actually loaded, so labels rasterize in Inter
      // (not a fallback) — the self-hosted font may still be loading on the first frame.
      // Non-fatal: a label-build failure must never tear down the whole GPU renderer
      // (labels are optional decoration), so it is swallowed here, not propagated to the catch.
      if (!this.labelBuilt && this.fontReady()) {
        try {
          this.buildLabelAtlas();
        } catch {
          /* labels optional — keep rendering the graph on the GPU without them */
        }
      }
      this.device.queue.writeBuffer(
        this.camUB,
        0,
        new Float32Array([this.camera.zoom, this.camera.tx, this.camera.ty, 0, this.W, this.H, 0, 0]),
      );
      // label tint = theme label colour × master alpha (cheap; a theme flip needs no atlas rebuild)
      const lc = this.theme.label;
      this.device.queue.writeBuffer(this.label.colUB, 0, new Float32Array([lc[0] / 255, lc[1] / 255, lc[2] / 255, LABEL_ALPHA]));

      const { ops, spriteN, ringN, ribbonF } = this.buildScene();
      if (spriteN) this.device.queue.writeBuffer(this.spriteVB, 0, this.spriteData, 0, spriteN * SPRITE_STRIDE);
      if (ringN) this.device.queue.writeBuffer(this.ringVB, 0, this.ringData, 0, ringN * RING_STRIDE);
      if (ribbonF) this.device.queue.writeBuffer(this.ribbonVB, 0, this.ribbonData, 0, ribbonF);

      // hub label instances: world position under each hub + its atlas UV rect + focus dim.
      let labelN = 0;
      if (this.atlasTex && this.labelBind) {
        const ld = this.labelData;
        for (const n of this.data.nodes) {
          if (!n.hub || labelN >= this.labelCap) continue;
          const meta = this.labelMeta.get(n.name);
          if (!meta) continue;
          const hh = meta.worldH / 2;
          const o = labelN * LABEL_STRIDE;
          ld[o] = n.x;
          ld[o + 1] = n.y + n.r + LABEL_GAP + hh; // top of the label sits LABEL_GAP below the node
          ld[o + 2] = meta.worldW / 2;
          ld[o + 3] = hh;
          ld[o + 4] = meta.uvOff[0];
          ld[o + 5] = meta.uvOff[1];
          ld[o + 6] = meta.uvScale[0];
          ld[o + 7] = meta.uvScale[1];
          ld[o + 8] = this.nodeFocusA(n.id);
          labelN++;
        }
        if (labelN) this.device.queue.writeBuffer(this.label.vb, 0, ld, 0, labelN * LABEL_STRIDE);
      }

      const view = this.ctx.getCurrentTexture().createView();
      const bg = this.theme.bgRgb;
      const a = GRAPH_BG_ALPHA;
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view,
            clearValue: { r: (bg[0] / 255) * a, g: (bg[1] / 255) * a, b: (bg[2] / 255) * a, a },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setBindGroup(0, this.camBind);
      for (const op of ops) {
        if (op.p === 'sprite') {
          pass.setPipeline(this.spritePipeline);
          pass.setVertexBuffer(0, this.quadVB);
          pass.setVertexBuffer(1, this.spriteVB);
          pass.draw(4, op.count, 0, op.first);
        } else if (op.p === 'ring') {
          pass.setPipeline(this.ringPipeline);
          pass.setVertexBuffer(0, this.quadVB);
          pass.setVertexBuffer(1, this.ringVB);
          pass.draw(4, op.count, 0, op.first);
        } else {
          pass.setPipeline(this.ribbonPipeline);
          pass.setVertexBuffer(0, this.ribbonVB);
          pass.draw(op.count, 1, op.first, 0);
        }
      }
      // hub labels last (on top of the graph), with their own bind group (atlas + tint)
      if (labelN && this.labelBind) {
        pass.setPipeline(this.label.pipeline);
        pass.setBindGroup(0, this.labelBind);
        pass.setVertexBuffer(0, this.quadVB);
        pass.setVertexBuffer(1, this.label.vb);
        pass.draw(4, labelN, 0, 0);
      }
      pass.end();
      this.device.queue.submit([enc.finish()]);
    } catch {
      this.stop();
      this.fireLost();
    }
  }
}
