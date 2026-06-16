import { useEffect, useLayoutEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { livePreviewPlugin } from './decorations';
import { roseGlassTheme } from './theme';
import { wikilinkClickHandler } from './wikilinkClick';
import './editor.css';

/** Marks a programmatic doc replacement so it doesn't trigger autosave. */
const External = Annotation.define<boolean>();
/** Editability toggles with whether a note is open (read-only empty state — no
 *  silently-discarded typing). */
const editableCompartment = new Compartment();

interface Props {
  doc: string;
  notePath: string | null;
  onChangeDoc: (doc: string) => void;
  onWikiClick: (target: string) => void;
  className?: string;
}

/** Imperative CodeMirror 6 host. React owns only the mount <div>; the EditorView
 *  is created once (StrictMode-safe) and its doc swapped via transactions. */
export function CodeMirrorHost({ doc, notePath, onChangeDoc, onWikiClick, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChangeDoc);
  const onWikiRef = useRef(onWikiClick);
  const docRef = useRef(doc);

  // keep callback/doc refs current so the extensions array stays stable
  useLayoutEffect(() => {
    onChangeRef.current = onChangeDoc;
    onWikiRef.current = onWikiClick;
    docRef.current = doc;
  });

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: docRef.current,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          editableCompartment.of(EditorView.editable.of(false)),
          livePreviewPlugin,
          wikilinkClickHandler((t) => onWikiRef.current(t)),
          roseGlassTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) {
              onChangeRef.current(u.state.doc.toString());
            }
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // swap the document when the open note changes (or an external reload sets a new
  // doc); always sync editability with whether a note is open.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const editableEffect = editableCompartment.reconfigure(
      EditorView.editable.of(notePath != null),
    );
    if (view.state.doc.toString() === doc) {
      view.dispatch({ effects: editableEffect }); // doc unchanged — just flip editability
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
      effects: editableEffect,
      // External → not autosaved; addToHistory:false → Ctrl+Z can't undo a reload
      annotations: [External.of(true), Transaction.addToHistory.of(false)],
    });
  }, [notePath, doc]);

  return <div ref={hostRef} className={className} />;
}
