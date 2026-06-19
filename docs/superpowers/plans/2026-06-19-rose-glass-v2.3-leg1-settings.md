# Rose Glass v2.3 — Leg 1: Settings framework + Behavior/Advanced editor settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted settings store + a categorized Settings menu (General/Editor/Behavior/Advanced) and wire the Behavior/Advanced editor toggles into CodeMirror live (spellcheck, auto-pair brackets, auto-pair markdown, smart lists, indent tabs/spaces, Vim, HTML→Markdown paste).

**Architecture:** A pure `settings.ts` store (interface + load/save-over-defaults to localStorage, mirroring `graph/config.ts`). A thin `SettingsContext` wraps `<Shell/>`; `CodeMirrorHost` and `SettingsPane` consume it via `useSettings()`/`useSetSettings()`. Each editor toggle is a CodeMirror **Compartment** reconfigured live on settings change — no editor remount. Pure logic (settings merge, smart-list continuation, HTML→MD conversion) is TDD'd; the CM6/UI wiring is verified by tsc + build + an eyeball checklist.

**Tech Stack:** React 19 + TS strict, CodeMirror 6 (`@codemirror/state` Compartment, `@codemirror/view`, `@codemirror/commands`, `@codemirror/lang-markdown`), Vitest. New deps: `@codemirror/autocomplete`, `@codemirror/language`, `@replit/codemirror-vim`, `turndown` (+`@types/turndown`).

## Global Constraints

- Package manager: **pnpm**; all commands run from `apps/desktop` unless noted. Rust from `apps/desktop/src-tauri`.
- Gates (must stay green): `pnpm exec tsc --noEmit` = 0 · `pnpm exec vitest run` (Rust untouched this leg) · `pnpm exec vite build` = 0. Don't run the full vitest suite while `tauri dev` is up (it flakes — run subsets).
- Conventional commits; end messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and `Claude-Session:` footers. A pre-commit hook blocks `git commit` unless ` # self-audit-ok` is appended to the bash call (after a genuine self-audit). Stage item files explicitly (no `git add -A`).
- Branch: `feat/v2.3` (already created; the spec lives there).
- Tests co-locate as `*.test.ts` next to the module (repo convention).
- TS strict: no `any`, exhaustive types, `import type` for type-only imports.

---

## File structure

- Create `src/settings/settings.ts` — `Settings` interface, `DEFAULT_SETTINGS`, `loadSettings()`, `saveSettings()`. Pure.
- Create `src/settings/settings.test.ts` — merge-over-defaults tests.
- Create `src/settings/SettingsContext.tsx` — provider + `useSettings()` + `useSetSettings()`.
- Create `src/editor/smartLists.ts` — pure `listContinuation()` + the `smartListKeymap` extension. 
- Create `src/editor/smartLists.test.ts`.
- Create `src/editor/htmlPaste.ts` — pure `htmlToMarkdown()` + the `htmlPasteExtension()` factory.
- Create `src/editor/htmlPaste.test.ts`.
- Create `src/editor/markdownPairs.ts` — `markdownPairExtension` (auto-pair `*_`~\``).
- Create `src/shell/Toggle.tsx` — on/off slider + `<Select>` presentational components.
- Modify `src/main.tsx` — wrap `<Shell/>` in `<SettingsProvider>`.
- Modify `src/editor/CodeMirrorHost.tsx` — consume settings, add compartments + reconfigure effect.
- Modify `src/shell/SettingsPane.tsx` — categorized sections; drop the props it no longer needs from Shell (theme/reindex stay; new toggles read context).
- Modify `src/shell/panes.css` (or `editor.css`) — `.sp-section`, `.rg-toggle`, `.rg-select` styles.

---

## Task 1: Settings model (`settings.ts`)

**Files:**
- Create: `src/settings/settings.ts`
- Test: `src/settings/settings.test.ts`

**Interfaces:**
- Produces: `interface Settings`, `DEFAULT_SETTINGS: Settings`, `loadSettings(): Settings`, `saveSettings(s: Settings): void`.

- [ ] **Step 1: Write the failing test**

```ts
// src/settings/settings.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';

beforeEach(() => localStorage.clear());

describe('settings store', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('merges a partial stored object over defaults (forward-compatible)', () => {
    localStorage.setItem('rose-glass:settings', JSON.stringify({ vimMode: true, spellcheck: false }));
    const s = loadSettings();
    expect(s.vimMode).toBe(true);
    expect(s.spellcheck).toBe(false);
    expect(s.autoPairBrackets).toBe(DEFAULT_SETTINGS.autoPairBrackets); // untouched key keeps default
  });

  it('falls back to defaults on garbage / bad JSON', () => {
    localStorage.setItem('rose-glass:settings', '{not json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('coerces an invalid defaultView enum back to the default', () => {
    localStorage.setItem('rose-glass:settings', JSON.stringify({ defaultView: 'banana' }));
    expect(loadSettings().defaultView).toBe(DEFAULT_SETTINGS.defaultView);
  });

  it('round-trips through save', () => {
    const next = { ...DEFAULT_SETTINGS, smartLists: false };
    saveSettings(next);
    expect(loadSettings()).toEqual(next);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/settings/settings.test.ts`
Expected: FAIL — cannot resolve `./settings`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/settings/settings.ts
/* App settings — persisted to localStorage, merged over defaults (forward-compatible),
   mirroring graph/config.ts. Pure: no React, no IPC. Editor toggles are consumed by
   CodeMirrorHost via compartments; the two tab-dependent fields are stored now but only
   take effect once tabs (leg 4) + reading mode (leg 3) land. */

export interface Settings {
  // Editor — tab-dependent (stored now; wired in legs 3/4)
  alwaysFocusNewTabs: boolean;
  defaultView: 'edit' | 'read';
  // Behavior
  spellcheck: boolean;
  autoPairBrackets: boolean;
  autoPairMarkdown: boolean;
  smartLists: boolean;
  indentWithTabs: boolean;
  // Advanced
  convertHtmlPaste: boolean;
  vimMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  alwaysFocusNewTabs: true,
  defaultView: 'edit',
  spellcheck: true,
  autoPairBrackets: true,
  autoPairMarkdown: true,
  smartLists: true,
  indentWithTabs: true, // matches the editor's current indentWithTab behavior
  convertHtmlPaste: true,
  vimMode: false,
};

const KEY = 'rose-glass:settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const p = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...p,
      // enum guard: anything but 'read' resolves to the default 'edit'
      defaultView: p.defaultView === 'read' ? 'read' : DEFAULT_SETTINGS.defaultView,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — settings just won't persist this session */
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/settings/settings.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settings/settings.ts src/settings/settings.test.ts
git commit -m "feat(v2.3): persisted Settings store (merge-over-defaults)  # self-audit-ok"
```
(Append the Co-Authored-By / Claude-Session footers via a heredoc as in the repo convention.)

---

## Task 2: Settings context + provider

**Files:**
- Create: `src/settings/SettingsContext.tsx`
- Modify: `src/main.tsx:17-21`

**Interfaces:**
- Consumes: `Settings`, `DEFAULT_SETTINGS`, `loadSettings`, `saveSettings` (Task 1).
- Produces: `SettingsProvider` (component), `useSettings(): Settings`, `useSetSettings(): (patch: Partial<Settings>) => void`.

> No unit test — this is ~25 lines of standard React context with no branching logic (YAGNI per repo's ponytail convention). Verified by tsc + the leg eyeball. The logic it depends on (`loadSettings` merge) is already tested in Task 1.

- [ ] **Step 1: Write the context**

```tsx
// src/settings/SettingsContext.tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings';

const SettingsCtx = createContext<Settings>(DEFAULT_SETTINGS);
const SetSettingsCtx = createContext<(patch: Partial<Settings>) => void>(() => {});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const patch = useCallback((p: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...p };
      saveSettings(next);
      return next;
    });
  }, []);
  const value = useMemo(() => settings, [settings]);
  return (
    <SettingsCtx.Provider value={value}>
      <SetSettingsCtx.Provider value={patch}>{children}</SetSettingsCtx.Provider>
    </SettingsCtx.Provider>
  );
}

export const useSettings = () => useContext(SettingsCtx);
export const useSetSettings = () => useContext(SetSettingsCtx);
```

- [ ] **Step 2: Wrap `<Shell/>` in `main.tsx`**

Modify `src/main.tsx` — replace the render block (lines 17-21):

```tsx
import { SettingsProvider } from './settings/SettingsContext';
// ...
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <Shell />
    </SettingsProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/settings/SettingsContext.tsx src/main.tsx
git commit -m "feat(v2.3): SettingsContext provider wrapping the app  # self-audit-ok"
```

---

## Task 3: Smart-lists logic (`smartLists.ts`)

**Files:**
- Create: `src/editor/smartLists.ts`
- Test: `src/editor/smartLists.test.ts`

**Interfaces:**
- Produces: `listContinuation(lineText: string): { kind: 'continue'; insert: string } | { kind: 'clear' } | null`, and `smartListKeymap` (a CodeMirror `Extension`).
- Behavior: on Enter inside a list item, continue the marker (`- `, `* `, `1.`→`2.`) and preserve leading indent; on an **empty** list item, clear the marker (exit the list).

- [ ] **Step 1: Write the failing test**

```ts
// src/editor/smartLists.test.ts
import { describe, it, expect } from 'vitest';
import { listContinuation } from './smartLists';

describe('listContinuation', () => {
  it('continues an unordered item, preserving indent', () => {
    expect(listContinuation('  - hello')).toEqual({ kind: 'continue', insert: '  - ' });
    expect(listContinuation('* world')).toEqual({ kind: 'continue', insert: '* ' });
  });
  it('increments an ordered item', () => {
    expect(listContinuation('3. third')).toEqual({ kind: 'continue', insert: '4. ' });
    expect(listContinuation('  10. ten')).toEqual({ kind: 'continue', insert: '  11. ' });
  });
  it('clears an empty item (exit the list)', () => {
    expect(listContinuation('- ')).toEqual({ kind: 'clear' });
    expect(listContinuation('  1. ')).toEqual({ kind: 'clear' });
  });
  it('returns null for a non-list line', () => {
    expect(listContinuation('plain text')).toBeNull();
    expect(listContinuation('# heading')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/editor/smartLists.test.ts`
Expected: FAIL — cannot resolve `./smartLists`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/editor/smartLists.ts
/* Smart-lists: continue/renumber a Markdown list item on Enter, exit on an empty item.
   ponytail: a pragmatic line-level heuristic, not a full Markdown list AST — handles
   `-`/`*`/`+` and `N.` with indent preservation; cross-blank renumber is best-effort. */
import { EditorSelection } from '@codemirror/state';
import { keymap } from '@codemirror/view';

const UNORDERED = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)\.\s+(.*)$/;

export function listContinuation(
  lineText: string,
): { kind: 'continue'; insert: string } | { kind: 'clear' } | null {
  const u = UNORDERED.exec(lineText);
  if (u) {
    const [, indent, bullet, body] = u;
    return body.length === 0 ? { kind: 'clear' } : { kind: 'continue', insert: `${indent}${bullet} ` };
  }
  const o = ORDERED.exec(lineText);
  if (o) {
    const [, indent, num, body] = o;
    if (body.length === 0) return { kind: 'clear' };
    return { kind: 'continue', insert: `${indent}${Number(num) + 1}. ` };
  }
  return null;
}

/** Enter handler: applies listContinuation at the cursor's line. Returns false (default
    newline) for non-list lines so normal editing is untouched. */
export const smartListKeymap = keymap.of([
  {
    key: 'Enter',
    run: (view) => {
      const { state } = view;
      const sel = state.selection.main;
      if (!sel.empty) return false;
      const line = state.doc.lineAt(sel.head);
      // only act when the cursor is at end of the line (Obsidian-like)
      if (sel.head !== line.to) return false;
      const cont = listContinuation(line.text);
      if (!cont) return false;
      if (cont.kind === 'clear') {
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: '' },
          selection: EditorSelection.cursor(line.from),
        });
        return true;
      }
      const insert = '\n' + cont.insert;
      view.dispatch({
        changes: { from: sel.head, insert },
        selection: EditorSelection.cursor(sel.head + insert.length),
      });
      return true;
    },
  },
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/editor/smartLists.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/editor/smartLists.ts src/editor/smartLists.test.ts
git commit -m "feat(v2.3): smart-lists continuation logic + Enter keymap  # self-audit-ok"
```

---

## Task 4: HTML→Markdown paste (`htmlPaste.ts`)

**Files:**
- Create: `src/editor/htmlPaste.ts`
- Test: `src/editor/htmlPaste.test.ts`
- Modify: `package.json` (add `turndown`, `@types/turndown`)

**Interfaces:**
- Produces: `htmlToMarkdown(html: string): string`, and `htmlPasteExtension(opts: { enabled: () => boolean; rawNext: { current: boolean } }): Extension`.
- Behavior: on paste, if `enabled()` and clipboard has `text/html` and `rawNext.current` is false, insert the converted Markdown; otherwise let CodeMirror's default paste run. `rawNext` is set true for one paste by the Ctrl/Cmd+Shift+V keymap.

- [ ] **Step 1: Add the dependency**

Run (from `apps/desktop`):
```bash
pnpm add turndown && pnpm add -D @types/turndown
```
Expected: `turndown` in dependencies, `@types/turndown` in devDependencies.

- [ ] **Step 2: Write the failing test**

```ts
// src/editor/htmlPaste.test.ts
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from './htmlPaste';

describe('htmlToMarkdown', () => {
  it('converts headings and bold to Markdown', () => {
    expect(htmlToMarkdown('<h1>Title</h1>')).toBe('# Title');
    expect(htmlToMarkdown('<strong>bold</strong>')).toBe('**bold**');
  });
  it('converts links', () => {
    expect(htmlToMarkdown('<a href="https://x.com">x</a>')).toBe('[x](https://x.com)');
  });
  it('uses fenced code blocks', () => {
    expect(htmlToMarkdown('<pre><code>a()</code></pre>')).toContain('```');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run src/editor/htmlPaste.test.ts`
Expected: FAIL — cannot resolve `./htmlPaste`.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/editor/htmlPaste.ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run src/editor/htmlPaste.test.ts`
Expected: PASS (3 tests). (Turndown runs in jsdom; if vitest's environment is `node`, this task's test file needs `// @vitest-environment jsdom` at the top — add it if the run errors on `document`.)

- [ ] **Step 6: Commit**

```bash
git add src/editor/htmlPaste.ts src/editor/htmlPaste.test.ts package.json pnpm-lock.yaml
git commit -m "feat(v2.3): HTML->Markdown paste converter + handler (turndown)  # self-audit-ok"
```

---

## Task 5: Markdown auto-pair (`markdownPairs.ts`)

**Files:**
- Create: `src/editor/markdownPairs.ts`

**Interfaces:**
- Produces: `markdownPairExtension: Extension` — when the user types `*`, `_`, `` ` ``, or `~` with a non-empty selection, wrap the selection; with an empty selection, insert the pair and place the cursor between.

> No unit test: it's a single `EditorView.inputHandler` over public API; behavior is verified in the leg eyeball (typing `*` around a selection wraps it). The risky logic (lists, HTML→MD) is already tested.

- [ ] **Step 1: Write the extension**

```ts
// src/editor/markdownPairs.ts
/* Auto-pair Markdown emphasis/code delimiters. `closeBrackets` (Task 6) handles ()[]{}""''
   `*_`~ are Markdown-specific, so pair them here via inputHandler. */
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';

const PAIRS = new Set(['*', '_', '`', '~']);

export const markdownPairExtension = EditorView.inputHandler.of((view, from, to, text) => {
  if (!PAIRS.has(text) || from !== to) {
    // wrap a non-empty selection
    if (PAIRS.has(text) && from !== to) {
      view.dispatch({
        changes: [
          { from, insert: text },
          { to, insert: text },
        ],
        selection: EditorSelection.range(from + 1, to + 1),
      });
      return true;
    }
    return false;
  }
  // empty selection: insert the pair, cursor between
  view.dispatch({
    changes: { from, insert: text + text },
    selection: EditorSelection.cursor(from + 1),
  });
  return true;
});
```

> NOTE for the implementer: `EditorView.inputHandler.of((view, from, to, text) => boolean)` is the CM6 6.x signature. Confirm against the installed `@codemirror/view` version; if the wrap-on-selection path conflicts with `closeBrackets`, gate this extension to run only for the 4 Markdown chars (it already does).

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/editor/markdownPairs.ts
git commit -m "feat(v2.3): auto-pair Markdown emphasis/code delimiters  # self-audit-ok"
```

---

## Task 6: Wire compartments into CodeMirrorHost

**Files:**
- Modify: `src/editor/CodeMirrorHost.tsx`
- Modify: `package.json` (add `@codemirror/autocomplete`, `@codemirror/language`, `@replit/codemirror-vim`)

**Interfaces:**
- Consumes: `useSettings` (Task 2), `smartListKeymap` (Task 3), `htmlPasteExtension` (Task 4), `markdownPairExtension` (Task 5).
- Produces: a CodeMirrorHost that reads `useSettings()` and applies each editor setting via a Compartment, reconfigured live.

> Integration wiring (EditorView + DOM). Verified by tsc + `vite build` + the leg eyeball checklist (toggle each setting in the running app and observe). The branching logic it relies on is unit-tested in Tasks 1/3/4.

- [ ] **Step 1: Add dependencies**

Run (from `apps/desktop`):
```bash
pnpm add @codemirror/autocomplete @codemirror/language @replit/codemirror-vim
```
Expected: all three in dependencies.

- [ ] **Step 2: Add compartments + settings consumption**

Modify `src/editor/CodeMirrorHost.tsx`. Add imports:

```tsx
import { Compartment } from '@codemirror/state';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { indentUnit } from '@codemirror/language';
import { vim } from '@replit/codemirror-vim';
import { useSettings } from '../settings/SettingsContext';
import { smartListKeymap } from './smartLists';
import { markdownPairExtension } from './markdownPairs';
import { htmlPasteExtension } from './htmlPaste';
```

Inside the component, before the create-effect, read settings + declare per-host compartments (refs so the create-effect stays `[]`):

```tsx
const settings = useSettings();
const settingsRef = useRef(settings);
settingsRef.current = settings;
const rawPasteRef = useRef(false); // one-shot: Ctrl/Cmd+Shift+V → raw paste
// one Compartment per live-toggle-able concern (created once per host)
const cmp = useRef({
  vim: new Compartment(),
  spellcheck: new Compartment(),
  brackets: new Compartment(),
  mdPairs: new Compartment(),
  smartList: new Compartment(),
  indent: new Compartment(),
}).current;
```

Add a pure builder (module scope, above the component) that maps settings → each compartment's extension:

```tsx
import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { Settings } from '../settings/settings';

function vimExt(s: Settings): Extension { return s.vimMode ? vim() : []; }
function spellcheckExt(s: Settings): Extension {
  return EditorView.contentAttributes.of({ spellcheck: String(s.spellcheck), autocorrect: 'off', autocapitalize: 'off' });
}
function bracketsExt(s: Settings): Extension {
  return s.autoPairBrackets ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : [];
}
function mdPairsExt(s: Settings): Extension { return s.autoPairMarkdown ? markdownPairExtension : []; }
function smartListExt(s: Settings): Extension { return s.smartLists ? smartListKeymap : []; }
function indentExt(s: Settings): Extension { return indentUnit.of(s.indentWithTabs ? '\t' : '    '); }
```

- [ ] **Step 3: Insert compartments into the initial extensions array**

In the `EditorState.create({ extensions: [...] })`, put `cmp.vim.of(vimExt(...))` **FIRST** (vim wraps keymaps), `cmp.smartList` **before** `defaultKeymap` (so Enter-in-list wins), and the rest anywhere before `roseGlassTheme`. Seed each from `docRef`-style current settings via `settingsRef.current`:

```tsx
extensions: [
  cmp.vim.of(vimExt(settingsRef.current)),
  history(),
  cmp.smartList.of(smartListExt(settingsRef.current)),
  keymap.of([
    { key: 'Mod-Shift-v', run: () => { rawPasteRef.current = true; return false; } }, // raw-paste one-shot
    ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab,
  ]),
  markdown({ base: markdownLanguage }),
  EditorView.lineWrapping,
  cmp.spellcheck.of(spellcheckExt(settingsRef.current)),
  cmp.brackets.of(bracketsExt(settingsRef.current)),
  cmp.mdPairs.of(mdPairsExt(settingsRef.current)),
  cmp.indent.of(indentExt(settingsRef.current)),
  htmlPasteExtension({ enabled: () => settingsRef.current.convertHtmlPaste, rawNext: rawPasteRef }),
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
```

(`Mod-Shift-v` returns `false` so the paste still fires; it only flips the raw flag the paste handler reads. The `htmlPasteExtension` reads `enabled`/`rawNext` through refs, so it never needs reconfiguring.)

- [ ] **Step 4: Add a reconfigure effect (live toggles, no remount)**

After the doc-swap effect:

```tsx
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
  // cmp is a stable per-host ref; depend on the settings fields that drive extensions
}, [settings, cmp]);
```

- [ ] **Step 5: Verify compile + build**

Run: `pnpm exec tsc --noEmit && pnpm exec vite build`
Expected: tsc 0, build succeeds (a `@replit/codemirror-vim` chunk is fine).

- [ ] **Step 6: Commit**

```bash
git add src/editor/CodeMirrorHost.tsx package.json pnpm-lock.yaml
git commit -m "feat(v2.3): wire editor settings into CodeMirror via compartments  # self-audit-ok"
```

---

## Task 7: Categorized Settings menu (`SettingsPane.tsx` + `Toggle`)

**Files:**
- Create: `src/shell/Toggle.tsx`
- Modify: `src/shell/SettingsPane.tsx`
- Modify: `src/shell/Shell.tsx:749-756` (SettingsPane no longer needs new props — only theme/vault/reindex stay)
- Modify: `src/shell/panes.css` — `.sp-section`, `.rg-toggle`, `.rg-select`

**Interfaces:**
- Consumes: `useSettings`, `useSetSettings` (Task 2).
- Produces: `Toggle` (labeled on/off slider) + `Select` (labeled dropdown) components; a SettingsPane with General / Editor / Behavior / Advanced sections.

> Presentational + wiring; verified by tsc + build + eyeball. No unit test.

- [ ] **Step 1: Create the Toggle/Select components**

```tsx
// src/shell/Toggle.tsx
/* Labeled on/off slider + labeled dropdown for the Settings menu. Presentational only. */
export function Toggle({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="rg-toggle">
      <span className="rg-toggle-text">
        <span className="rg-toggle-label">{label}</span>
        {hint && <span className="rg-toggle-hint">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="rg-toggle-track" aria-hidden="true" />
    </label>
  );
}

export function Select<T extends string>({ label, hint, value, options, onChange, disabled }: {
  label: string; hint?: string; value: T; options: { value: T; label: string }[];
  onChange: (v: T) => void; disabled?: boolean;
}) {
  return (
    <label className="rg-select">
      <span className="rg-toggle-text">
        <span className="rg-toggle-label">{label}</span>
        {hint && <span className="rg-toggle-hint">{hint}</span>}
      </span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
```

- [ ] **Step 2: Restructure SettingsPane into sections**

Rewrite `SettingsPane.tsx` to read `useSettings()`/`useSetSettings()` and render sections. Keep the existing Theme / Vault / Index / activity-hook fields (move Index + activity-hook under **Advanced**; Theme + Vault under **General**). Add Behavior + Advanced toggles and the two **disabled** Editor (tab) settings:

```tsx
const s = useSettings();
const set = useSetSettings();
// ...
// GENERAL: Theme, Vault  (Version/Help arrive in leg 5)
// EDITOR:
<Toggle label="Always focus new tabs" hint="Tabs land in v2.3 — disabled for now"
        checked={s.alwaysFocusNewTabs} onChange={() => {}} /* disabled */ />
<Select label="Default view for new tabs" hint="Reading mode lands in v2.3 — disabled for now"
        value={s.defaultView} disabled options={[{value:'edit',label:'Editing'},{value:'read',label:'Reading'}]}
        onChange={(v) => set({ defaultView: v })} />
// BEHAVIOR:
<Toggle label="Spellcheck" checked={s.spellcheck} onChange={(v) => set({ spellcheck: v })} />
<Toggle label="Auto-pair brackets" checked={s.autoPairBrackets} onChange={(v) => set({ autoPairBrackets: v })} />
<Toggle label="Auto-pair Markdown syntax" checked={s.autoPairMarkdown} onChange={(v) => set({ autoPairMarkdown: v })} />
<Toggle label="Smart lists" hint="Continue/renumber list items automatically"
        checked={s.smartLists} onChange={(v) => set({ smartLists: v })} />
<Toggle label="Indent using tabs" hint="Off = indent with 4 spaces"
        checked={s.indentWithTabs} onChange={(v) => set({ indentWithTabs: v })} />
// ADVANCED: (then existing Index rebuild + activity-hook)
<Toggle label="Convert pasted HTML to Markdown" hint="Ctrl/Cmd+Shift+V pastes raw"
        checked={s.convertHtmlPaste} onChange={(v) => set({ convertHtmlPaste: v })} />
<Toggle label="Vim key bindings" checked={s.vimMode} onChange={(v) => set({ vimMode: v })} />
```

For the disabled "Always focus new tabs" Toggle, add a `disabled` prop to `Toggle` (mirror `Select`'s) and pass it; render those two rows visibly disabled with the hint.

- [ ] **Step 3: Drop the now-unused props from the Shell call**

In `Shell.tsx`, `SettingsPane` keeps `theme`, `onToggleTheme`, `vault`, `onReindex`, `reindexing` (Theme + Vault + Index still use props). The settings toggles come from context, so no new props. Confirm the SettingsPane prop types match.

- [ ] **Step 4: Add styles**

Append to `src/shell/panes.css`: `.sp-section` (header + group), `.rg-toggle` (flex row, slider track via the `:checked` sibling), `.rg-select` (flex row). Use the existing `--glass-*`, `--surface-*`, `--text-*`, `--rose`, `--r-sm/md` tokens — no hardcoded hex (matches the v2.0 `/impeccable` graph-panel fix). Disabled rows get `opacity: .5`.

- [ ] **Step 5: Verify compile + build**

Run: `pnpm exec tsc --noEmit && pnpm exec vite build`
Expected: tsc 0, build OK.

- [ ] **Step 6: Commit**

```bash
git add src/shell/Toggle.tsx src/shell/SettingsPane.tsx src/shell/Shell.tsx src/shell/panes.css
git commit -m "feat(v2.3): categorized Settings menu (General/Editor/Behavior/Advanced)  # self-audit-ok"
```

---

## Task 8: Leg gates + eyeball + push

- [ ] **Step 1: Full leg gates**

Run (from `apps/desktop`): `pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm exec vite build`
Expected: tsc 0 · vitest all green (existing 95 + the new settings/smartLists/htmlPaste tests) · build OK. (Rust untouched this leg.)

- [ ] **Step 2: Eyeball checklist (run `pnpm tauri dev`)**

Open Settings (⚙ rail). Verify each, in a note:
- Spellcheck on → misspelled word gets the red underline; off → none.
- Auto-pair brackets on → typing `(` inserts `()` with cursor inside; off → just `(`.
- Auto-pair Markdown on → select a word, type `*` → wraps to `*word*`; off → replaces.
- Smart lists on → Enter after `- a` makes `- `; Enter on an empty `- ` clears it; off → plain newline.
- Indent using tabs on → Tab inserts a tab; off → 4 spaces.
- Vim on → modal editing (Esc → normal, `i` → insert); off → normal editing.
- HTML→MD paste on → paste copied rich web text → arrives as Markdown; Ctrl+Shift+V → raw.
- Settings persist across an app relaunch.
- The two Editor "tabs" rows render disabled with their "lands in v2.3" hint.

- [ ] **Step 3: Push**

```bash
git push origin feat/v2.3
```

---

## Self-Review

**Spec coverage (leg 1 scope):** Settings framework (Tasks 1,2,7) ✓ · Spellcheck/Auto-pair brackets/Auto-pair Markdown/Smart lists/Indent (Tasks 3,5,6) ✓ · Vim + HTML→MD paste (Tasks 4,6) ✓ · categorized menu with the two tab-settings present-but-disabled (Task 7) ✓. Deferred to later legs (correctly absent here): graph (leg 2), reading mode (leg 3), tabs (leg 4), version/updates/help (leg 5).

**Placeholder scan:** none — every code step has full code; wiring tasks (2,5,7) are explicitly marked test-free with an eyeball check and carry complete code.

**Type consistency:** `Settings` fields are referenced identically across `settings.ts`, `SettingsContext.tsx`, the `*Ext(s: Settings)` builders, and `SettingsPane.tsx`. `htmlPasteExtension({ enabled, rawNext })` and `listContinuation` signatures match their consumers in Task 6. The `rawNext` ref shape (`{ current: boolean }`) matches `rawPasteRef` in CodeMirrorHost.

**Known confirm-at-build flags (calibrated-confidence):** `EditorView.inputHandler.of` signature (Task 5) and the `closeBracketsKeymap`/`closeBrackets` import path (Task 6) are CM6 6.x public API — confirm against the installed versions; the turndown test may need `@vitest-environment jsdom` (Task 4 Step 5).
