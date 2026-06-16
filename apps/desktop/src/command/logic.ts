/** Wrap-around index for ↑/↓ result navigation. */
export function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  return ((i % len) + len) % len;
}
