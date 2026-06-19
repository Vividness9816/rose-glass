import { type MutableRefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { indentUnit } from '@codemirror/language';
import { vim } from '@replit/codemirror-vim';
import { livePreviewPlugin } from './decorations';
import { roseGlassTheme } from './theme';
import { wikilinkClickHandler } from './wikilinkClick';
import { smartListKeymap } from './smartLists';
import { markdownPairExtension } from './markdownPairs';
import { htmlPasteExtension } from './htmlPaste';
import { useSettings } from '../settings/SettingsContext';
import type { Settings } from '../settings/settings';
import './editor.css';

/** Marks a programmatic doc replacement so it doesn't trigger autosave. */
const External = Annotation.define<boolean>();
/** Editability toggles with whether a note is open (read-only empty state — no
 *  silently-discarded typing). */
const editableCompartment = new Compartment();

// settings → each live-toggle-able editor extension (one Compartment per concern, below).
function vimExt(s: Settings): Extension {
  return s.vimMode ? vim() : [];
}
function spellcheckExt(s: Settings): Extension {
  return EditorView.contentAttributes.of({
    spellcheck: String(s.spellcheck),
    autocorrect: 'off',
    autocapitalize: 'off',
  });
}
function bracketsExt(s: Settings): Extension {
  return s.autoPairBrackets ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : [];
}
function mdPairsExt(s: Settings): Extension {
  return s.autoPairMarkdown ? markdownPairExtension : [];
}
function smartListExt(s: Settings): Extension {
  return s.smartLists ? smartListKeymap : [];
}
function indentExt(s: Settings): Extension {
  return indentUnit.of(s.indentWithTabs ? '\t' : '    ');
}

interface Props {
  doc: string;
  notePath: string | null;
  onChangeDoc: (doc: string) => void;
  onWikiClick: (target: string) => void;
  className?: string;
  /** Optional: receives the live EditorView so chrome (e.g. the Outline) can scroll it. */
  editorViewRef?: MutableRefObject<EditorView | null>;
}

/** Imperative CodeMirror 6 host. React owns only the mount <div>; the EditorView
 *  is created once (StrictMode-safe) and its doc swapped via transactions. Editor
 *  settings ride live-reconfigured Compartments — no remount on a settings change. */
export function CodeMirrorHost({
  doc,
  notePath,
  onChangeDoc,
  onWikiClick,
  className,
  editorViewRef,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChangeDoc);
  const onWikiRef = useRef(onWikiClick);
  const docRef = useRef(doc);

  const settings = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const rawPasteRef = useRef(false); // one-shot: Ctrl/Cmd+Shift+V → next paste stays raw
  // one Compartment per live-toggle-able concern (created once per host)
  const cmp = useRef({
    vim: new Compartment(),
    spellcheck: new Compartment(),
    brackets: new Compartment(),
    mdPairs: new Compartment(),
    smartList: new Compartment(),
    indent: new Compartment(),
  }).current;

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
          cmp.vim.of(vimExt(settingsRef.current)), // vim wraps keymaps → must be first
          history(),
          cmp.smartList.of(smartListExt(settingsRef.current)), // before the default keymap so Enter-in-list wins
          keymap.of([
            // Ctrl/Cmd+Shift+V: flag the next paste raw (handler reads it); false → paste still fires
            { key: 'Mod-Shift-v', run: () => ((rawPasteRef.current = true), false) },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          cmp.spellcheck.of(spellcheckExt(settingsRef.current)),
          cmp.brackets.of(bracketsExt(settingsRef.current)),
          cmp.mdPairs.of(mdPairsExt(settingsRef.current)),
          cmp.indent.of(indentExt(settingsRef.current)),
          htmlPasteExtension({
            enabled: () => settingsRef.current.convertHtmlPaste,
            rawNext: rawPasteRef,
          }),
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
    if (editorViewRef) editorViewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
      if (editorViewRef) editorViewRef.current = null;
    };
    // editorViewRef is a stable ref container; the editor is created once (StrictMode-safe)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-apply editor settings via the compartments (no remount, no doc/selection loss).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        cmp.vim.reconfigure(vimExt(settings)),
        cmp.spellcheck.reconfigure(spellcheckExt(settings)),
        cmp.brackets.reconfigure(bracketsExt(settings)),
        cmp.mdPairs.reconfigure(mdPairsExt(settings)),
        cmp.smartList.reconfigure(smartListExt(settings)),
        cmp.indent.reconfigure(indentExt(settings)),
      ],
    });
  }, [settings, cmp]);

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
