# Morning review — v1.0 verification runbook (2026-06-18)

Everything is **code-complete, reviewed, committed, pushed** on `master`
(`Vividness9816/rose-glass`, HEAD `9f104f9`, tree clean, in sync). The only thing
between here and **v1.0** is **your live-Tauri-window eyeball** — the rows below are
gate-green but *not headless-verifiable* (they need the running app, real Claude Code
activity, native file dialogs, and your taste call). Nothing here is faked "verified."

## Gates — re-verified green this session (run from `C:\Users\dnoye\rose-glass`)
```
pnpm --filter @rose-glass/desktop exec tsc --noEmit                              # 0
pnpm --filter @rose-glass/desktop test                                           # vitest 73/73
pnpm --filter @rose-glass/desktop build                                          # 0
cargo test  --manifest-path apps/desktop/src-tauri/Cargo.toml                    # 53/53 (+9 mcp, +3 #[ignore]d)
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings   # 0
```

## Formal `/impeccable` pass — DONE this session (closes the A2/A11 "formal Impeccable run" residual)
Ran critique + audit against the visual contract (`docs/design-reference.html`) over the
committed HEAD render proofs (graph dark+light, glass chrome, ⌘K palette).

- **Anti-slop verdict: PASS.** Distinctive, intentional, hand-built. None of the absolute
  bans present — the glass is purposeful chrome over a living backdrop (the intended
  aesthetic), not decorative cards; no gradient text, no hero-metric template, no
  identical-card grids. The rail's 2px active indicator is the conventional IDE
  active-nav pattern, not a card side-stripe.
- **Strongest surface:** the dark graph (auras / hub rings / curved edges read as a
  hand-built neural map). **Soft spot:** the *light* graph field — cluster auras muddy
  into pink halos against the saturated rose backdrop. This is a **taste dial, your call**
  (`ShaderBackdrop.tsx` opacity `0.8`, `GraphRenderer.ts` `GRAPH_BG_ALPHA` `0.4`). Not
  changed autonomously.
- **One objective a11y finding — FIXED (2026-06-18, user-approved path B):** dark-theme
  `--text-3` was `#7d4f5a` (~3.0:1, below WCAG-AA 4.5:1) on the de-emphasized metadata it
  carries (⌘K placeholder, statusbar, breadcrumb segs, kbd hints). Bumped to **`#a6757f`** —
  same mauve hue, clears 4.5:1 on **every** dark surface (worst case the kbd chip on
  `--surface-3` = 4.64:1). A10-clean (one token, zero component edits); A2 visual baselines
  unchanged (the shift on small text is sub-2%-tolerance — 4/4 still pass). Light theme was
  already AA-clean and is untouched.

## The flip-list — open the app, do these, flip §20 🟡→✅
```
cd C:\Users\dnoye\rose-glass\apps\desktop
pnpm tauri dev      # NOT from C:\Users\dnoye (pnpm junction-dupes → :1420 collisions)
```
| §20 | Action in the live window | Pass = |
|---|---|---|
| **A1** | Watch the DevTools console on boot | 0 errors (the `favicon.ico` 404 is the known cosmetic exception) |
| **A5** | Open a vault → wheel-zoom, drag-pan, drag a node, click a node (opens it); toggle **GPU/2D** in the graph header; click **Focus** on an open note | feel is right · GPU look acceptable · 2D keeps working after toggle · Focus dims all but the open note + its links |
| **A6** | Open the **◎ Activity** rail on the **sanitized** vault `C:\Users\dnoye\rg-test-vault`; in another terminal run `claude` and read/edit a file *inside that vault* | node flares (read=violet / modify=rose) · pane streams sessions · external rows are **path-free** · health row ticks liveness/tally |
| **A8** | With a vault open, **Open file…** a `.pdf`, then a `.docx`; on the docx click **Edit as Markdown** | PDF renders read-only · docx renders read-only · a sibling `<name>.docx.md` opens in CM6 (the `.docx` is never mutated) |
| **A11** | Eyeball backdrop / glass / both graph themes | taste-accept (or hand me the two dials above) |
| round-2 | Window min/max/close + **⛶ fullscreen**; **Share** (clipboard copy); terminal tab **double-click rename** + **bell** attention dot; **Properties** popover shows on-disk size | each behaves as labelled |

Then **Phase 12** = the full §20 gate: with every row ✅, tag **v1.0**.

## 🔒 Reserved-for-you, NOT touched autonomously (ADR-20260617)
- **`~/.claude/settings.json` is never written by me.** Phase 8 ships **M1 transcript-tail
  only** (read-only). The **M2 global hook is a view-only / deferred no-op** (`node -e 0`,
  always exit 0 — the old broken placeholder was neutralized). The arm/disarm path
  (`installer.rs`: backup → re-validate-all → atomic write, proven against your live
  settings read-only — 20 hooks preserved + round-trips) exists, but **arming is your
  in-app click**, never autonomous.

## Phase 13 — semantic search SHIPPED (2026-06-18, brute-force per ADR-20260618)
- **KNN semantic search over the stored embeddings is BUILT.** `/council` (5/5) chose
  **brute-force cosine KNN in pure Rust** over the existing `embeddings` BLOBs, **not the
  sqlite-vec C extension** — the vectors already live in-Rust and a linear scan is
  sub-perceptible for a personal vault; sqlite-vec/HNSW is the named upgrade past ~100k
  notes (ADR-20260618). Surfaces: a model-free **"Related"** list in the editor
  (`related_notes`) + a free-text `semantic_search` IPC. Freshness contract: both surface
  `ready=false` / `stale` (recompute clusters to enable/refresh) instead of silently ranking
  a partial corpus. Gates: cargo lib 71 (+9 KNN/semantic tests) · clippy 0 · tsc/vitest/build 0.
- **App-window eyeball (the live part):** open a note → the **Related** list ranks
  similar notes (click "Clusters" first if it says "enable semantic search"); after a
  recompute it self-heals without a note switch.

## Optional (non-gating) leftovers — build only if you want them
- **sqlite-vec / in-memory HNSW** — the indexed-search upgrade for the brute-force KNN
  above; only earns its keep past ~tens-of-thousands of notes + a *measured* latency
  regression (ADR-20260618). An MCP `search_semantic` tool is deferred too (no external
  caller yet — decisions.md #8; the FTS `search` tool already serves the sidecar).
- **Real M2 hook forwarding** — needs `/council` (ADR-20260617 deferred it for cost/dedup;
  M1 already covers the use case).
- **`tauri-plugin-decorum`** frameless edge-resize (current ceiling: reduced edge-resize on
  Windows for the frameless window).
- **Populated A2 visual diffs** (editor-with-content / search-results) — needs a
  Tauri-driven Playwright run; the web build only shows empty states for those.

## Where state lives
`STATUS.md` (§20 ledger — source of truth, per-row commit + artifact) · `ROADMAP.md`
(phase status) · `docs/decisions.md` (run decisions) · `docs/design-reference.html`
(visual contract) · ADRs in `~/.claude/second-brain/decisions/`.
