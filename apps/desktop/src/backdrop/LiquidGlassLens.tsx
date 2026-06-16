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
      tintColor: theme === 'light' ? '#be1846' : '#f43f5e',
      zIndex: 50,
      draggable: true,
    });
    return () => glass.destroy();
  }, [theme]);
  return null;
}
