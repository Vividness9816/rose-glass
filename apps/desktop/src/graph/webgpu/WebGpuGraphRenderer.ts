/* Phase 4 — WebGPU graph renderer (the §6/§11.3 primary path; canvas-2D is the
   fallback). Instanced node discs (circle SDF in the fragment shader) + edge lines,
   sharing the canvas-2D path's `Camera`, `hitTest`, and seedable `stepSimulation`
   so pan/zoom/drag/click-open and the layout are identical across backends.

   SAFETY (§17 / ADR-20260616): `create()` is the ONLY constructor and it returns
   `null` on ANY init failure (no adapter/device, pipeline validation error, lost
   context) — the caller then keeps the proven canvas-2D renderer. A WebGPU bug can
   therefore never blank or break the graph; worst case the GPU toggle is a no-op.

   ⚠ BUILT BUT NOT GPU-VERIFIED — the actual render needs a live GPU (the user's
   RTX 5090) to confirm. tsc + @webgpu/types validate the API surface; the pixels
   are a pending eyeball. Do not mark A5 "proven" on this path without that.

   FIDELITY: this GPU path renders a REDUCED visual set vs the canvas-2D path —
   disc nodes + flat-alpha straight edges + a colour/radius pulse, WITHOUT the 2D
   path's cluster auras, slime trails, tributary particles, hub rings/labels,
   curved edges, or expanding activity-flare rings. Layout + interaction are
   identical (shared camera/hitTest/stepSimulation); only the look is leaner. Decide
   whether to close the gap AFTER the eyeball confirms the simpler look is wanted —
   don't grow shaders blind. */

import type { GraphData, GraphNode } from '../types';
import type { GraphTheme } from '../themeColors';
import type { GraphRendererLike } from '../Renderer';
import { type Camera, IDENTITY_CAMERA, panBy, screenToWorld, zoomAt } from '../camera';
import { nodeAtWorld } from '../hitTest';
import { stepSimulation } from '../simulation';
import { indexNodesByPath, lookupNodeByRel } from '../GraphRenderer';

const GRAPH_BG_ALPHA = 0.4; // matches the canvas-2D path (lets the §21 backdrop bleed through)

const SHADER = /* wgsl */ `
struct Cam { z: vec4<f32>, v: vec4<f32> };       // z=(zoom,tx,ty,_), v=(W,H,_,_)
@group(0) @binding(0) var<uniform> cam: Cam;

fn toClip(world: vec2<f32>) -> vec2<f32> {
  let s = world * cam.z.x + cam.z.yz;            // world -> screen (CSS px)
  return vec2<f32>(s.x / cam.v.x * 2.0 - 1.0, 1.0 - s.y / cam.v.y * 2.0);
}

struct NodeOut { @builtin(position) pos: vec4<f32>, @location(0) local: vec2<f32>, @location(1) col: vec3<f32> };
@vertex
fn vs_node(@location(0) corner: vec2<f32>, @location(1) ipos: vec2<f32>, @location(2) ir: f32, @location(3) icol: vec3<f32>) -> NodeOut {
  var o: NodeOut;
  o.pos = vec4<f32>(toClip(ipos + corner * ir), 0.0, 1.0);
  o.local = corner;
  o.col = icol;
  return o;
}
@fragment
fn fs_node(@location(0) local: vec2<f32>, @location(1) col: vec3<f32>) -> @location(0) vec4<f32> {
  let d = length(local);
  if (d > 1.0) { discard; }
  let a = smoothstep(1.0, 0.80, d);
  return vec4<f32>(col * a, a);                  // premultiplied alpha
}

struct EdgeOut { @builtin(position) pos: vec4<f32>, @location(0) col: vec3<f32> };
@vertex
fn vs_edge(@location(0) wpos: vec2<f32>, @location(1) col: vec3<f32>) -> EdgeOut {
  var o: EdgeOut;
  o.pos = vec4<f32>(toClip(wpos), 0.0, 1.0);
  o.col = col;
  return o;
}
@fragment
fn fs_edge(@location(0) col: vec3<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(col * 0.45, 0.45);            // premultiplied alpha
}
`;

const NODE_STRIDE = 6; // x,y,r,r,g,b  (floats per instance)
const EDGE_STRIDE = 5; // x,y,r,g,b    (floats per edge vertex)

export class WebGpuGraphRenderer implements GraphRendererLike {
  private camera: Camera = IDENTITY_CAMERA;
  private draggingId: number | null = null;
  private theme: GraphTheme;
  private W: number;
  private H: number;
  private dpr: number;
  private raf = 0;
  private running = false;
  private pulses = new Map<number, { kind: 'read' | 'modify'; t: number }>();
  private pathIndex: { exact: Map<string, GraphNode>; lower: Map<string, GraphNode> };
  private nodeData: Float32Array;
  private edgeData: Float32Array;

  private constructor(
    canvas: HTMLCanvasElement,
    private data: GraphData,
    theme: GraphTheme,
    dpr: number,
    private device: GPUDevice,
    private ctx: GPUCanvasContext,
    private nodePipeline: GPURenderPipeline,
    private edgePipeline: GPURenderPipeline,
    private camUB: GPUBuffer,
    private camBind: GPUBindGroup,
    private quadVB: GPUBuffer,
    private nodeVB: GPUBuffer,
    private edgeVB: GPUBuffer,
    private onLost: (() => void) | undefined,
  ) {
    this.theme = theme;
    this.dpr = dpr;
    this.W = canvas.width / dpr;
    this.H = canvas.height / dpr;
    this.pathIndex = indexNodesByPath(data.nodes);
    this.nodeData = new Float32Array(data.nodes.length * NODE_STRIDE);
    this.edgeData = new Float32Array(data.edges.length * 2 * EDGE_STRIDE);
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
      // External loss → signal the caller (GraphPane) to fall back to canvas-2D.
      void device.lost.then((info) => {
        if (info.reason !== 'destroyed') onLost?.();
      });
      const ctx = canvas.getContext('webgpu');
      if (!ctx) {
        device.destroy();
        return null;
      }
      const format = gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: 'premultiplied' });

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
      const nodePipeline = device.createRenderPipeline({
        layout,
        vertex: {
          module,
          entryPoint: 'vs_node',
          buffers: [
            { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
            {
              arrayStride: NODE_STRIDE * 4,
              stepMode: 'instance',
              attributes: [
                { shaderLocation: 1, offset: 0, format: 'float32x2' },
                { shaderLocation: 2, offset: 8, format: 'float32' },
                { shaderLocation: 3, offset: 12, format: 'float32x3' },
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fs_node', targets: [{ format, blend }] },
        primitive: { topology: 'triangle-strip' },
      });
      const edgePipeline = device.createRenderPipeline({
        layout,
        vertex: {
          module,
          entryPoint: 'vs_edge',
          buffers: [
            {
              arrayStride: EDGE_STRIDE * 4,
              stepMode: 'vertex',
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32x3' },
              ],
            },
          ],
        },
        fragment: { module, entryPoint: 'fs_edge', targets: [{ format, blend }] },
        primitive: { topology: 'line-list' },
      });
      const err = await device.popErrorScope();
      if (err) {
        device.destroy(); // pipeline/shader validation failed → release + fall back to 2D
        return null;
      }

      const camUB = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const camBind = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: camUB } }] });
      const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
      const quadVB = device.createBuffer({ size: quad.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(quadVB, 0, quad);
      const nodeVB = device.createBuffer({
        size: Math.max(1, data.nodes.length) * NODE_STRIDE * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      const edgeVB = device.createBuffer({
        size: Math.max(1, data.edges.length) * 2 * EDGE_STRIDE * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });

      return new WebGpuGraphRenderer(canvas, data, theme, dpr, device, ctx, nodePipeline, edgePipeline, camUB, camBind, quadVB, nodeVB, edgeVB, onLost);
    } catch {
      try {
        device?.destroy(); // don't leak the device if we acquired it before throwing
      } catch {
        /* already lost */
      }
      return null; // any init throw → caller keeps canvas-2D
    }
  }

  setTheme(theme: GraphTheme) {
    this.theme = theme;
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
  pickAtScreen(sx: number, sy: number): GraphNode | undefined {
    const [wx, wy] = screenToWorld(this.camera, sx, sy);
    return nodeAtWorld(this.data.nodes, wx, wy);
  }
  moveNodeToScreen(id: number, sx: number, sy: number) {
    const n = this.data.nodes.find((m) => m.id === id);
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
  // ponytail: focus dimming is a 2D-path feature today; the GPU renderer lands it with
  // the shader-parity increment. No-op keeps the toggle from breaking on the GPU path.
  setFocus(_path: string | null) {}

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
    // Release GPU resources — GraphPane discards the instance on teardown/toggle and
    // builds a fresh one, so a non-destroying stop would leak a device per toggle.
    try {
      this.nodeVB.destroy();
      this.edgeVB.destroy();
      this.quadVB.destroy();
      this.camUB.destroy();
      this.device.destroy();
    } catch {
      /* already released / context lost */
    }
  }

  private frame() {
    const { data, theme } = this;
    // shared layout + drag pin (identical to the 2D path)
    const drag = this.draggingId !== null ? data.nodes.find((n) => n.id === this.draggingId) : undefined;
    const px = drag?.x;
    const py = drag?.y;
    stepSimulation(data.nodes, this.W, this.H);
    if (drag && px !== undefined && py !== undefined) {
      drag.x = px;
      drag.y = py;
      drag.vx = 0;
      drag.vy = 0;
    }
    this.pulses.forEach((p, id) => {
      p.t *= 0.95;
      if (p.t < 0.02) this.pulses.delete(id);
    });

    const clusterRgb = (c: number) => theme.clusters[c]?.rgb ?? theme.clusters[0].rgb;
    // ALL GPU work is guarded: an external device loss surfaces here as a throw
    // (e.g. getCurrentTexture) → stop + onLost → GraphPane rebuilds on canvas-2D.
    try {
      // camera uniform
      const cam = this.camera;
      this.device.queue.writeBuffer(
        this.camUB,
        0,
        new Float32Array([cam.zoom, cam.tx, cam.ty, 0, this.W, this.H, 0, 0]),
      );

      // node instances (cluster colour, boosted toward the activity colour while pulsing)
      const nd = this.nodeData;
      data.nodes.forEach((n, i) => {
        const p = this.pulses.get(n.id);
        const base = clusterRgb(n.cluster);
        let [r, g, b] = base;
        let rad = Math.max(2, n.r);
        if (p) {
          const acc = p.kind === 'read' ? theme.activityRead : theme.activityModify;
          const t = p.t;
          r = base[0] + (acc[0] - base[0]) * t;
          g = base[1] + (acc[1] - base[1]) * t;
          b = base[2] + (acc[2] - base[2]) * t;
          rad *= 1 + 0.6 * t;
        }
        const o = i * NODE_STRIDE;
        nd[o] = n.x;
        nd[o + 1] = n.y;
        nd[o + 2] = rad;
        nd[o + 3] = r / 255;
        nd[o + 4] = g / 255;
        nd[o + 5] = b / 255;
      });
      if (nd.length) this.device.queue.writeBuffer(this.nodeVB, 0, nd);

      // edges — compact only valid endpoints so a missing node never draws a stale
      // origin-line (the 2D path skips such edges; match that).
      const ed = this.edgeData;
      let edgeVerts = 0;
      for (const e of data.edges) {
        const a = data.nodes[e.a];
        const b = data.nodes[e.b];
        if (!a || !b) continue;
        const cross = a.cluster !== b.cluster;
        const col = cross ? theme.crossEdge : clusterRgb(a.cluster);
        const cr = col[0] / 255;
        const cg = col[1] / 255;
        const cb = col[2] / 255;
        const o = edgeVerts * EDGE_STRIDE;
        ed[o] = a.x; ed[o + 1] = a.y; ed[o + 2] = cr; ed[o + 3] = cg; ed[o + 4] = cb;
        ed[o + 5] = b.x; ed[o + 6] = b.y; ed[o + 7] = cr; ed[o + 8] = cg; ed[o + 9] = cb;
        edgeVerts += 2;
      }
      if (edgeVerts) this.device.queue.writeBuffer(this.edgeVB, 0, ed.subarray(0, edgeVerts * EDGE_STRIDE));

      // encode
      const view = this.ctx.getCurrentTexture().createView();
      const bg = theme.bgRgb;
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
      if (edgeVerts) {
        pass.setPipeline(this.edgePipeline);
        pass.setVertexBuffer(0, this.edgeVB);
        pass.draw(edgeVerts);
      }
      if (data.nodes.length) {
        pass.setPipeline(this.nodePipeline);
        pass.setVertexBuffer(0, this.quadVB);
        pass.setVertexBuffer(1, this.nodeVB);
        pass.draw(4, data.nodes.length);
      }
      pass.end();
      this.device.queue.submit([enc.finish()]);
    } catch {
      // context lost / GPU error mid-frame → tear down + ask the caller to fall back.
      this.stop();
      this.onLost?.();
    }
  }
}
