/* Phase 4 GPU parity — hub-label atlas layout (pure).
   The 2D path draws each hub's name with `ctx.fillText`; WebGPU has no text
   primitive. To match it we rasterize the hub label strings (bold Inter, white
   coverage) into ONE offscreen canvas, upload it as a texture, and draw a textured
   quad per hub (tinted to the theme label colour in the fragment). This module is the
   pure, testable half: it shelf-packs the measured label boxes into the atlas and
   returns each label's pixel rect — the renderer turns those into UVs. Kept separate +
   unit-tested so the packing math (no overlap, in-bounds, row-wrap) is verified without
   a GPU, exactly like ribbon.ts. */

export interface LabelMetric {
  text: string;
  w: number; // measured pixel width (at the atlas font scale)
  h: number; // pixel line height
}

export interface LabelRect {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasLayout {
  atlasW: number;
  atlasH: number;
  rects: LabelRect[];
}

/** Shelf-pack measured labels into one atlas. Labels fill a row left→right until the
    next would exceed `maxW`, then wrap to a new row (a single over-wide label still gets
    its own row). `pad` px around each box prevents bilinear bleed between neighbours. */
export function layoutLabelAtlas(labels: LabelMetric[], maxW = 1024, pad = 2): AtlasLayout {
  const rects: LabelRect[] = [];
  let x = pad;
  let y = pad;
  let rowH = 0;
  let atlasW = 1;
  for (const l of labels) {
    // wrap when the row already has content and this box won't fit
    if (x > pad && x + l.w + pad > maxW) {
      y += rowH + pad;
      x = pad;
      rowH = 0;
    }
    rects.push({ text: l.text, x, y, w: l.w, h: l.h });
    x += l.w + pad;
    rowH = Math.max(rowH, l.h);
    atlasW = Math.max(atlasW, x);
  }
  const atlasH = rects.length ? y + rowH + pad : 1;
  return { atlasW: Math.max(1, atlasW), atlasH: Math.max(1, atlasH), rects };
}
