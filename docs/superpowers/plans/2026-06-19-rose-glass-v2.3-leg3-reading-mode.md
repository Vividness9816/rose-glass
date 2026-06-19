# Rose Glass v2.3 — Leg 3: Reading mode — Implementation Plan

> **For agentic workers:** TDD where logic is pure (the Markdown render/transform); the React view + toggle are tsc+build+eyeball-verified. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A read-only rendered-Markdown view with an Edit/Read toggle in the editor header, seeded by the "Default view" setting (which this leg enables).

**Architecture:** A pure `mdRender(doc)` converts Markdown → sanitized HTML: a wikilink pre-pass rewrites `[[t|a]]`/`[[t]]` → `<a class="rg-wikilink" data-wikilink="t">a</a>`, then `markdown-it` (html:true) renders, then DOMPurify sanitizes. `ReadingView` injects that HTML and delegates `data-wikilink` clicks to the existing nav. `EditorPane` holds a per-note `mode` (seeded from `settings.defaultView`) and swaps `CodeMirrorHost` ↔ `ReadingView`.

**Tech Stack:** React 19 + TS, `markdown-it` (new dep), DOMPurify (already a dep), Vitest. Reuses `useSettings` (leg 1).

## Global Constraints

- Commands from `apps/desktop`. Gates: `pnpm exec tsc --noEmit` 0 · `pnpm exec vitest run` · `pnpm exec vite build` 0. (Rust untouched this leg.)
- Conventional commits + Co-Authored-By/Claude-Session footers; ` # self-audit-ok` on each `git commit`. Stage explicitly. Branch `feat/v2.3`.
- DOMPurify allows `data-*` + `class` by default — `data-wikilink` survives sanitization with no extra config. Custom URI schemes (`rgwiki:`) would be stripped, so we use a `data-` attribute + no href, not a custom-scheme href.

## File structure

- Create `src/editor/mdRender.ts` — `mdRender(doc: string): string` (wikilink pre-pass + markdown-it + DOMPurify). Pure.
- Create `src/editor/mdRender.test.ts`.
- Create `src/editor/ReadingView.tsx` — renders `mdRender(doc)`, delegates wikilink clicks.
- Modify `src/shell/EditorPane.tsx` — per-note `mode` (seeded from `settings.defaultView`), Edit/Read toggle, swap CM6 ↔ ReadingView.
- Modify `src/shell/SettingsPane.tsx` — enable the "Default view" Select (drop `disabled` + the "disabled for now" hint).
- Modify `src/editor/editor.css` (or `panes.css`) — `.reading-view` typography + `.rg-wikilink`.
- Modify `package.json` — add `markdown-it`, `@types/markdown-it`.

---

## Task 1: `mdRender` (TDD)

**Files:** Create `src/editor/mdRender.ts`, `src/editor/mdRender.test.ts`. Modify `package.json`.

**Interfaces:** Produces `mdRender(doc: string): string` (sanitized HTML).

- [ ] **Step 1: Add deps** — from `apps/desktop`: `pnpm add markdown-it && pnpm add -D @types/markdown-it`.

- [ ] **Step 2: Write the failing test**

```ts
// src/editor/mdRender.test.ts
import { describe, it, expect } from 'vitest';
import { mdRender } from './mdRender';

describe('mdRender', () => {
  it('renders Markdown to HTML', () => {
    expect(mdRender('# Title')).toContain('<h1>Title</h1>');
    expect(mdRender('**bold**')).toContain('<strong>bold</strong>');
  });
  it('rewrites wikilinks to data-wikilink anchors', () => {
    const h = mdRender('see [[Note A]] and [[b/c|Alias]]');
    expect(h).toContain('data-wikilink="Note A"');
    expect(h).toContain('>Note A<');
    expect(h).toContain('data-wikilink="b/c"');
    expect(h).toContain('>Alias<');
  });
  it('strips dangerous markup (XSS)', () => {
    expect(mdRender('<script>alert(1)</script>')).not.toContain('<script>');
    expect(mdRender('<img src=x onerror=alert(1)>')).not.toContain('onerror');
  });
});
```

- [ ] **Step 3: Run — expect fail** (`pnpm exec vitest run src/editor/mdRender.test.ts`).

- [ ] **Step 4: Implement**

```ts
// src/editor/mdRender.ts
/* Markdown → sanitized HTML for the reading view. A wikilink pre-pass turns [[t|a]] into a
   data-wikilink anchor (DOMPurify keeps data-* + class; a custom-scheme href would be
   stripped), then markdown-it renders, then DOMPurify sanitizes.
   ponytail: the wikilink regex also matches inside code fences (rare) — acceptable; a full
   AST pass is the upgrade if it bites. */
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&quot;').replace(/"/g, '&quot;');
}

/** [[target]] / [[target|alias]] → an anchor the ReadingView delegates on click. */
function rewriteWikilinks(doc: string): string {
  return doc.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const t = target.trim();
    const label = (alias ?? target).trim();
    return `<a class="rg-wikilink" data-wikilink="${escapeHtml(t)}">${escapeHtml(label)}</a>`;
  });
}

export function mdRender(doc: string): string {
  const html = md.render(rewriteWikilinks(doc));
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
```

- [ ] **Step 5: Run — expect pass.** (markdown-it + DOMPurify run in jsdom-free node? DOMPurify needs a DOM — in node it requires `jsdom`. If the test errors on `window`/`document`, prepend `// @vitest-environment jsdom` to the test file AND add `pnpm add -D jsdom`. Check first — if DOMPurify throws "DOMPurify requires a window", that's the fix.)

- [ ] **Step 6: Commit** — `git add src/editor/mdRender.ts src/editor/mdRender.test.ts package.json pnpm-lock.yaml` + the conventional message.

---

## Task 2: `ReadingView` component

**Files:** Create `src/editor/ReadingView.tsx`. Modify `editor.css`.

**Interfaces:** Consumes `mdRender` (Task 1). Produces `ReadingView({ doc, onWikiClick }: { doc: string; onWikiClick: (target: string) => void })`.

> Wiring + render; verified by tsc + build + eyeball. The render logic is tested in Task 1.

- [ ] **Step 1: Write the component**

```tsx
// src/editor/ReadingView.tsx
/* Read-only rendered-Markdown view (the Edit/Read 'Read' mode). mdRender sanitizes; we
   delegate clicks on [[wikilink]] anchors (data-wikilink) to the existing nav. */
import { useMemo } from 'react';
import { mdRender } from './mdRender';

export function ReadingView({ doc, onWikiClick, className }: {
  doc: string;
  onWikiClick: (target: string) => void;
  className?: string;
}) {
  const html = useMemo(() => mdRender(doc), [doc]);
  return (
    <div
      className={`reading-view${className ? ` ${className}` : ''}`}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a.rg-wikilink');
        const target = a?.getAttribute('data-wikilink');
        if (target) {
          e.preventDefault();
          onWikiClick(target);
        }
      }}
      // sanitized by mdRender (DOMPurify) — safe to inject
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
```

- [ ] **Step 2: Add `.reading-view` styles** to `editor.css` — readable prose width/spacing using the existing tokens (`--text-1/2`, `--font`, `--rose` for `.rg-wikilink`). Headings/lists/code styled from tokens; `.rg-wikilink { color: var(--rose); cursor: pointer; }`.

- [ ] **Step 3: Verify** — `pnpm exec tsc --noEmit && pnpm exec vite build` (0).

- [ ] **Step 4: Commit** — `git add src/editor/ReadingView.tsx src/editor/editor.css`.

---

## Task 3: Edit/Read toggle in `EditorPane` + enable the setting

**Files:** Modify `src/shell/EditorPane.tsx`, `src/shell/SettingsPane.tsx`.

**Interfaces:** Consumes `useSettings` (leg 1), `ReadingView` (Task 2).

> Wiring; tsc + build + eyeball.

- [ ] **Step 1: Lazy-import ReadingView + read settings** — in `EditorPane.tsx`, add `const ReadingView = lazy(() => import('../editor/ReadingView').then((m) => ({ default: m.ReadingView })));` (mirrors PdfView/DocxView), and `const settings = useSettings();` (import `useSettings`).

- [ ] **Step 2: Per-note mode state, seeded from the setting**

```tsx
const [mode, setMode] = useState<'edit' | 'read'>(settings.defaultView);
// reset to the default view when the open note changes (per-note mode; leg 4 lifts this to per-tab)
useEffect(() => { setMode(settings.defaultView); }, [note?.path, settings.defaultView]);
```

- [ ] **Step 3: Edit/Read toggle button** — in `.editor-actions` (next to Outline/Properties/Share), add a button that flips `mode`, disabled when no `note`:
```tsx
<button className={`ea-btn${mode === 'read' ? ' active' : ''}`} type="button" disabled={!note}
  title={mode === 'read' ? 'Switch to editing' : 'Switch to reading'}
  onClick={() => setMode((m) => (m === 'read' ? 'edit' : 'read'))}>
  <Icon name={mode === 'read' ? 'edit' : 'book'} size="sm" />
</button>
```
(Use existing icon names; if `book`/`edit` aren't in the Icon set, reuse `outline`/`file` or add a glyph — check `icons/Icon.tsx`.)

- [ ] **Step 4: Swap the body** — where `<CodeMirrorHost .../>` renders, branch on mode:
```tsx
{mode === 'read' ? (
  <Suspense fallback={<div className="bv-status">Rendering…</div>}>
    <ReadingView className="note-body" doc={doc} onWikiClick={onWikiClick} />
  </Suspense>
) : (
  <CodeMirrorHost className="note-body cm-host" doc={doc} notePath={note?.path ?? null}
    onChangeDoc={onChangeDoc} onWikiClick={onWikiClick} editorViewRef={editorViewRef} />
)}
```

- [ ] **Step 5: Enable the "Default view" setting** — in `SettingsPane.tsx`, drop `disabled` from the Default-view `<Select>` and update the hint to describe it (remove "disabled for now"). Leave "Always focus new tabs" disabled (still needs tabs / leg 4).

- [ ] **Step 6: Verify** — `pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm exec vite build` (all green).

- [ ] **Step 7: Commit** — `git add src/shell/EditorPane.tsx src/shell/SettingsPane.tsx`.

---

## Task 4: Leg gates + eyeball + push

- [ ] **Step 1: Gates** — `cd apps/desktop && pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm exec vite build` (green).
- [ ] **Step 2: Headless render check** — serve `vite preview`, drive a note? (web build shows mock graph, no notes — reading mode needs an open note, so this is a Tauri eyeball.) At minimum confirm the build has no console errors on load.
- [ ] **Step 3: Eyeball (`pnpm tauri dev`, vault open):**
  - Open a note → an Edit/Read toggle appears in the editor header.
  - Switch to Read → the note renders as formatted HTML (headings/bold/lists/links); `[[wikilinks]]` are clickable and navigate.
  - Switch back to Edit → CodeMirror returns with the doc intact.
  - Settings → Editor → "Default view" = Reading → newly-opened notes start in Read mode.
- [ ] **Step 4: Push** — `git push origin feat/v2.3`.

## Self-Review

**Spec coverage:** reading mode (markdown-it + DOMPurify) ✓ · Edit/Read toggle ✓ · "Default view" setting enabled + seeds the mode ✓. Tabs-coupling deferred to leg 4 (per-note mode now; per-tab later). **Placeholder scan:** Icon-name fallback flagged (check `icons/Icon.tsx`); jsdom-for-DOMPurify flagged at Task 1 Step 5. **Type consistency:** `mode: 'edit' | 'read'` matches `settings.defaultView`; `mdRender(doc): string` consumed by ReadingView; `onWikiClick` reused from the existing EditorPane prop.
