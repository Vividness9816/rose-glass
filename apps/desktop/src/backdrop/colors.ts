import type { Theme } from '../appearance/theme';

/**
 * Backdrop gradient palette, per theme.
 *
 * This is the ONE sanctioned place outside tokens.css that holds concrete hex:
 * a WebGL shader cannot read CSS custom properties, so @shadergradient/react must
 * be handed real colors. The values are derived from the same rose/violet palette
 * as tokens.css (anti-pattern #7/#8: the generative layer is theme-aware, palette-
 * derived — never dark-only, never random). When tokens.css re-themes, mirror here.
 *
 * Tuned for restraint: deep, desaturated stops so the living mesh reads as an
 * ambient wash behind the translucent glass chrome — it must not overrule the
 * validated mockup (anti-pattern #10).
 */
export interface BackdropColors {
  color1: string;
  color2: string;
  color3: string;
}

const DARK: BackdropColors = {
  color1: '#0a0408', // --bg
  color2: '#3b0d22', // deep rose (derived from --rose / --rose-dim)
  color3: '#241043', // deep violet (derived from --violet / --violet-dim)
};

const LIGHT: BackdropColors = {
  color1: '#fdf2f4', // --bg (light)
  color2: '#f7c9d6', // soft rose
  color3: '#e7d6f6', // soft violet
};

export function backdropColors(theme: Theme): BackdropColors {
  return theme === 'light' ? LIGHT : DARK;
}
