/* SPIKE: eamonliu/liquid-glass-js over the live WebGL backdrop.
   It uses SVG feDisplacementMap (zero deps). Omitting `background` should use the
   native backdrop-filter path (works over WebGL in our Chromium/WebView2), vs the
   cross-browser DOM-clone path (which can't sample a <canvas>). The spike confirms
   which. Draggable lens, theme-tinted; destroyed on unmount. */

import { useEffect } from 'react';
import LiquidGlass from 'liquid-glass-js';
import type { Theme } from '../appearance/theme';

export function LiquidGlassLens({ theme }: { theme: Theme }) {
  useEffect(() => {
    // Tint from the token layer (NOT hardcoded): this is a DOM/SVG lens, not a WebGL
    // shader, so it must stay reskinnable — a re-theme of --rose recolors it. Re-read
    // on theme flip (the lens is recreated on [theme]). --rose is theme-adjusted.
    const rose = getComputedStyle(document.documentElement).getPropertyValue('--rose').trim();
    const glass = new LiquidGlass({
      width: 280,
      height: 180,
      radius: 28,
      scale: 56,
      depth: 12,
      curvature: 3,
      convexity: 1,
      chroma: 3,
      blur: 1.5,
      glow: 0.35,
      edge: 0.5,
      tint: 0.08,
      tintColor: rose || '#f43f5e',
      zIndex: 50,
      draggable: true,
    });
    return () => glass.destroy();
  }, [theme]);
  return null;
}
