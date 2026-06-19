/* Pure geometry for the resizable splits, isolated so the clamp math is unit-tested and a
   corrupt persisted value can't brick the layout. Clamp runs on READ (Shell's useState
   init), so a stored 0 / NaN / out-of-range value degrades to a sane default instead of
   collapsing a pane to 0px with no in-app recovery. Mirrors graph/config.ts:normalizeColors. */

/** Main graph↔right split: the graph pane's share of the container, kept off both edges. */
export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;

/** Terminal-drawer height (px) floor; the ceiling is viewport-relative, applied at drag time. */
export const TERM_H_MIN = 120;
export const TERM_H_DEFAULT = 300;

/** Clamp a 0..1 fraction; non-finite (NaN/±Infinity from a corrupt store) → fallback. */
export function clampFraction(f: number, fallback = 0.5, min = SPLIT_MIN, max = SPLIT_MAX): number {
  if (!Number.isFinite(f)) return fallback;
  return Math.min(max, Math.max(min, f));
}

/** Clamp a pixel size; non-finite → fallback. Used for the drawer height (min/max passed in). */
export function clampPx(px: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(px)) return fallback;
  return Math.min(max, Math.max(min, px));
}

/** Drag → fraction: pointer at `posPx` along a `totalPx` axis, clamped to the legal range. */
export function nextFraction(posPx: number, totalPx: number): number {
  if (totalPx <= 0) return 0.5;
  return clampFraction(posPx / totalPx);
}
