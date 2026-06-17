/* Backdrop §17 fallback gate — pure/testable, kept out of the .tsx so Fast Refresh
   stays intact. The animated WebGL backdrop is used ONLY when motion is allowed AND
   WebGL2 is actually available; otherwise the static token-driven gradient.

   Why a synchronous upfront probe (not just the error boundary): r3f v9 constructs
   the WebGLRenderer inside an uncaught async promise, and three throws synchronously
   when no WebGL2 context can be created (and for WebGL1-only GPUs). That throw becomes
   an unhandled rejection a React error boundary can NOT catch — so on a no-WebGL2 / weak
   GPU the canvas would blank instead of degrading. Probing here closes that gap
   deterministically (and skips the 890KB three.js chunk on machines that can't use it). */

let _webgl2: boolean | null = null;

export function hasWebGL2(): boolean {
  if (_webgl2 === null) {
    try {
      _webgl2 = !!document.createElement('canvas').getContext('webgl2');
    } catch {
      _webgl2 = false;
    }
  }
  return _webgl2;
}

export function prefersStaticBackdrop(reducedMotion: boolean, webgl2Available: boolean): boolean {
  return reducedMotion || !webgl2Available;
}
