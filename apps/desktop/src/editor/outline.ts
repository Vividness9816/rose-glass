/* Parse a markdown doc into its heading outline (for the editor's Outline popover).
   Pure: skips ATX headings inside fenced code blocks; line is 1-based (CM6 line index). */

export interface Heading {
  level: number; // 1..6
  text: string;
  line: number; // 1-based
}

export function parseOutline(doc: string): Heading[] {
  const out: Heading[] = [];
  const lines = doc.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
  }
  return out;
}
