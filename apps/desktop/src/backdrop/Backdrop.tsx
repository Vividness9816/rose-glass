/* Theme-aware living backdrop (spec §21). Sits at z-index 0 behind the app shell;
   the translucent glass chrome refracts it.

   The animated layer (ShaderBackdrop, r3f v9) is lazy-imported, which does two jobs:
   it keeps three.js off the critical path (instant first paint), and it makes any
   shader/WebGL init failure catchable by the boundary below (a static import of a
   crashing module is not — that's how @shadergradient/react blanked the app).

   Four guards, so WebGL can never blank the surface (spec §17):
     1. prefers-reduced-motion → static, token-driven gradient (no WebGL mounted).
     2. no WebGL2 (weak GPU / driver loss) → static, synchronously, before lazy-mount
        (closes the renderer-construction-failure gap the boundary can't — see logic.ts).
     3. chunk still loading → static gradient (Suspense fallback).
     4. any shader/render failure → static gradient (error boundary).
   pointer-events: none throughout → never intercepts shell interaction. */

import { Component, lazy, Suspense, type ReactNode, useSyncExternalStore } from 'react';
import type { Theme } from '../appearance/theme';
import { hasWebGL2, prefersStaticBackdrop } from './logic';
import './backdrop.css';

const ShaderBackdrop = lazy(() => import('./ShaderBackdrop'));

/** prefers-reduced-motion as a tear-free subscription (the correct React primitive — no effect). */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}

/** The always-safe layer: a static, fully token-driven gradient (theme-aware via CSS vars). */
function StaticBackdrop() {
  return <div className="backdrop-static" aria-hidden="true" />;
}

/** Catches any failure from the WebGL shader subtree and swaps in the static layer. */
class BackdropBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('backdrop shader failed; using static fallback:', err);
  }
  render() {
    return this.state.failed ? <StaticBackdrop /> : this.props.children;
  }
}

export function Backdrop({ theme }: { theme: Theme }) {
  const reduced = useReducedMotion();
  // §17: static (never the lazy WebGL canvas) when motion is reduced OR no WebGL2.
  // The WebGL2 probe closes the renderer-construction-failure gap the error boundary
  // can't (r3f builds the renderer in an uncaught async promise — see logic.ts).
  if (prefersStaticBackdrop(reduced, hasWebGL2())) return <StaticBackdrop />;

  return (
    <BackdropBoundary>
      <Suspense fallback={<StaticBackdrop />}>
        <ShaderBackdrop theme={theme} />
      </Suspense>
    </BackdropBoundary>
  );
}
