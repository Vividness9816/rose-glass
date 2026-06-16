import { EditorView } from '@codemirror/view';

/** Editor theme driven by the app's CSS custom properties — flipping `data-theme`
 *  re-resolves every var(), so light/dark re-themes the editor with zero JS. */
export const roseGlassTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--text-2)',
      backgroundColor: 'transparent',
      fontSize: '14px',
      height: '100%',
    },
    '.cm-content': {
      fontFamily: 'var(--font-ui)',
      lineHeight: '1.8',
      maxWidth: '620px',
      padding: '0',
      caretColor: 'var(--rose)',
    },
    '.cm-line': { padding: '0' },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: 'var(--rose)',
      borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--rose-glow)',
    },
    '.cm-gutters': { display: 'none' },
  },
  { dark: true },
);
