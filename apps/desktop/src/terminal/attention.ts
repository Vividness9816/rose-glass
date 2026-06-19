/* Pure "does this terminal want my attention?" decision, split out of the React/xterm
   wiring so the rule is ONE testable unit instead of an invariant smeared across Shell and
   TerminalPane. The bug this replaces: attention only flagged background tabs and only on
   the BEL char, so a single focused terminal could never light up. A terminal is
   "attended" only when you can actually see it right now — the active tab, in a visible
   drawer, in a focused window. Output (or a bell) while UNATTENDED earns the flag. */

export interface AttentionInputs {
  isActiveTab: boolean; // this tab is the selected one in the drawer
  isDrawerVisible: boolean; // the terminal drawer is shown (not Ctrl+`-hidden)
  isWindowFocused: boolean; // the app window has OS focus
}

/** Unattended ⇔ you are NOT currently looking at this terminal. */
export function isUnattended(i: AttentionInputs): boolean {
  return !(i.isActiveTab && i.isDrawerVisible && i.isWindowFocused);
}
