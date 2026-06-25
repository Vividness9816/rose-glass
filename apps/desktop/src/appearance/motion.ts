/* Motion preference — the SINGLE source of truth for "should the app reduce motion?".
   Combines the user's Animations setting with the OS prefers-reduced-motion signal and
   reflects the result onto <html data-reduce-motion> so the pure-CSS animations, the canvas
   DotField, and the motion/react components all read ONE value (mirrors theme.ts: defined
   once). Pure helpers — no React — so settings.ts can import the type and tests run headless.

   Why this exists: Windows' "Animation effects" toggle maps to prefers-reduced-motion, and
   users flip it for plain snappiness, not just accessibility — which silently killed every
   decorative animation. 'system' stays the default (accessibility-correct); 'on' lets a user
   opt back into motion regardless of that overloaded OS toggle. */

export const MOTION_PREFS = ['system', 'on', 'off'] as const;
export type MotionPref = (typeof MOTION_PREFS)[number];
export const DEFAULT_MOTION: MotionPref = 'system';

const QUERY = '(prefers-reduced-motion: reduce)';

/** Resolve whether motion should be REDUCED. 'on' forces full motion, 'off' forces reduced,
    'system' follows the OS. Pure — unit-tested in motion.test.ts. */
export function resolveReduceMotion(pref: MotionPref, systemReduce: boolean): boolean {
  if (pref === 'on') return false;
  if (pref === 'off') return true;
  return systemReduce;
}

export function systemPrefersReduce(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(QUERY).matches;
}

export function subscribeSystemReduce(cb: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

/** Reflect the resolved value so CSS (`:root[data-reduce-motion='1']`) can gate animations. */
export function applyReduceMotion(reduce: boolean): void {
  document.documentElement.setAttribute('data-reduce-motion', reduce ? '1' : '0');
}

/** Call once at boot (before first paint) so a reduced-motion user never sees a frame of
    motion. The useReduceMotion hook keeps it live after mount. */
export function initMotion(pref: MotionPref): void {
  applyReduceMotion(resolveReduceMotion(pref, systemPrefersReduce()));
}
