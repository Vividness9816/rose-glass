/* Convert pasted HTML → Markdown (Advanced setting). The converter is pure + tested; the
   paste handler is thin wiring. Ctrl/Cmd+Shift+V bypasses conversion (rawNext one-shot). */
import TurndownService from 'turndown';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

export function htmlPasteExtension(opts: { enabled: () => boolean; rawNext: { current: boolean } }): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (opts.rawNext.current) {
        opts.rawNext.current = false; // consume the one-shot raw flag; let default paste run
        return false;
      }
      if (!opts.enabled()) return false;
      const html = event.clipboardData?.getData('text/html');
      if (!html) return false; // no HTML payload → default (plain-text) paste
      const md = htmlToMarkdown(html);
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: md },
        selection: { anchor: sel.from + md.length },
      });
      event.preventDefault();
      return true;
    },
  });
}
