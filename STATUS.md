# STATUS — §20 acceptance ledger

Bounded, git-anchored (ADR-20260616). One row per §20 acceptance item. A row is
`proven` ONLY if it cites a re-runnable artifact (command + output, or a committed
screenshot). Prose "verified" without an artifact is a schema violation. Resumption
index: `git log --grep=phaseN`.

States: ✅ proven · 🟡 partial · 🟥 stubbed · ⬜ untouched

| Id | §20 acceptance item | State | Evidence (commit scope + artifact) |
|---|---|---|---|
| A1 | Boots clean, no runtime errors, `tsc` passes, unit tests green, Ponytail audit clean | ✅ | `tsc` 0; `vitest` **67/67** (+8 ribbon-tessellation); `vite build` 0 (three.js + viewer chunks lazy-split); `cargo test` **53/53** + `cargo clippy` 0 (+3 `#[ignore]`d, unchanged — GPU parity is TS-only); web render verified via Playwright (A2 harness), 0 console errors. **Ponytail audit clean** (2 read-only auditors, TS + Rust): verdict **lean** — no redundant deps, no speculative abstractions, data-safety/security paths intact, deliberate ceilings `ponytail:`-commented; only actionable cut applied = un-exported two internal-only `theme.ts` helpers (`applyTheme`/`setTheme`); `getTags`/`clampIndex` kept (live IPC-mirror / tested). ✅ **User walkthrough confirmed live (2026-06-18):** app boots clean in `tauri dev`, no runtime errors (the `favicon.ico` 404 is the known cosmetic exception). |
| A2 | Playwright visual diffs (shell/graph/editor/⌘K), light+dark; Impeccable on un-mocked | ✅ | **Automated screenshot-DIFF harness BUILT** (`@playwright/test`, `apps/desktop/playwright.config.ts` + `tests/visual/surfaces.spec.ts`, `pnpm test:visual`): gates the deterministic shell chrome (titlebar/rail/graph-controls/editor/⌘K palette/statusbar) in **light+dark** against committed baselines (`tests/visual/surfaces.spec.ts-snapshots/{shell,palette}-{dark,light}-win32.png`) — animated graph canvas masked, backdrop static via `reducedMotion`. **Proven deterministic: 4/4 pass on re-run** (system Edge = WebView2; no browser download). Plus static proof shots `docs/proof/phase{1,3,5,6}-*.png`. **Formal `/impeccable` critique+audit DONE (2026-06-18)** against the visual contract over the committed HEAD render proofs — verdict **anti-slop PASS** (distinctive/hand-built; no absolute-ban tells); the one objective a11y finding now **FIXED** (dark `--text-3` `#7d4f5a`→`#a6757f`, user-approved: clears WCAG-AA 4.5:1 on every dark surface text-3 lands on — worst case the kbd chip on `--surface-3` = 4.64:1; A2 baselines unchanged — the shift on small metadata text is sub-2%-tolerance, 4/4 still pass). ✅ **User visual-acceptance confirmed live (2026-06-18):** shell / graph / editor / ⌘K accepted in light+dark. Deferred (non-blocking harness coverage): automated diffs of *populated* editor/search states still need a Tauri-driven Playwright run (the web build only shows empty states). |
| A3 | Delete SQLite DB → reboot → index rebuilds equivalent | ✅ | `cargo test indexer::pipeline::tests::a3_delete_db_rebuild_is_equivalent` passes — builds index, snapshots, deletes DB, rebuilds, asserts order-independent equivalence (`phase2-indexer`). |
| A4 | Theme switches light/dark live, no reload, persisted | ✅ | Toggle flips `data-theme` + `--bg` `#0a0408`↔`#fdf2f4`, persists `localStorage app.theme`; `docs/proof/phase1-shell-light.png` (`phase1-shell`). **Light palette tuned in Phase 6** (bright→deep accent remap, dark graph node-cores): `phase6-backdrop-light.png` (`phase6-glass`). |
| A5 | Graph matches mockup; WebGPU 4K; gravity+collision+free clusters; click/zoom/drag/pan; WebGPU↔2D fallback | ✅ | Canvas-2D living graph (mockup physics, token-driven), fed by REAL indexer data + REAL semantic clusters (Phase 11). **Phase 4 added FULL interaction (wheel zoom-to-cursor, drag-pan, drag-node, click-to-open) — renderer-agnostic via a shared pure `Camera`/`hitTest`/seedable `stepSimulation`; proven by `vitest src/graph/interaction` (9) + headless render.** **WebGPU primary renderer (`WebGpuGraphRenderer`: instanced node discs + edge lines, same camera/layout) behind a probe + GPU/2D toggle with an airtight fallback** — `create()` returns null on ANY init failure + a per-backend canvas `key` remount + device-loss recovery (3-lens reviewed: 10/10 fixed incl. the HIGH fallback-on-committed-canvas bug). **WebGPU render + zoom GPU-VERIFIED on the RTX 5090** (adapter `nvidia/blackwell`, via headed Edge = the app's WebView2 engine): the toggle stays "GPU" (so `create()` succeeded — WGSL shaders + pipelines validated on the real GPU, no fallback), the graph renders (discs+edges, cluster-coloured, physics-laid-out — NOT blank), and wheel zoom-to-cursor works; 0 WebGPU console errors. Re-runnable: `docs/proof/phase4-webgpu-verify.cjs` + shots `phase4-webgpu-render.png` / `phase4-webgpu-zoom.png` vs 2D `phase4-2d-render.png`. **GPU VISUAL PARITY DONE (2026-06-17):** the WebGPU path now renders the full canvas-2D look via three instanced WGSL pipelines — sprite (soft cluster auras/glow + hard cores/particles/orbit-dots/highlights), ring (hub concentric rings / mid ring / accent strokes / flare rings), ribbon (CPU-tessellated curved quadratic edges + arrowheads + trail overlays + slime; the tessellator `ribbon.ts` is pure + unit-tested 8/8) — plus the **Focus local-graph dimming** and the **theme bullseye inversion** ports (both were 2D-only no-ops). 3-lens reviewed (7 findings, all LOW, all fixed: slime control-point parity, init under the validation+OOM error scope so an over-limit buffer returns null cleanly, one-shot device-loss, wash radius). GPU-verified on the RTX 5090 (`nvidia/blackwell`, headed Edge=WebView2) in **dark + light**: toggle stays "GPU" (no fallback), the render matches the 2D aura/curve/ring/particle look, zoom works, 0 console errors — `docs/proof/phase4-parity-{2d,gpu,gpu-zoom,gpu-light}.png` via `phase4-parity-verify.cjs`. **Hub TEXT labels now render too** (a 4th `label` pipeline: the hub names rasterized once via canvas-2D into one atlas texture — `labelAtlas.ts` pure-packed + 6/6 unit-tested — drawn as a textured quad per hub, white coverage tinted to the theme label colour in the fragment so a theme flip needs no rebuild; GPU-verified legible under each hub in **dark + light**) → **full visual parity**. 3-lens reviewed (9 findings: 1 MED + 8 LOW; all fixed/rejected — the MED: an over-limit atlas now skips rather than building an invalid texture, since WebGPU errors surface async past the frame catch; rejected: `RENDER_ATTACHMENT` is required by `copyExternalImageToTexture`). One honest residual: the label atlas is a **static 4× supersample** (not re-rasterized per zoom like the 2D `fillText`), so labels are crisp at typical zoom and soften only past ~4× magnification — a deliberate cheap-static-atlas trade (`ponytail:`-noted). Residual: drag/pan/click-open share the proven `camera`/`hitTest` (zoom screenshot-verified; the rest pure-tested); ✅ **User walkthrough confirmed live (2026-06-18):** wheel-zoom / drag-pan / drag-node / click-to-open feel + Focus local-graph dimming + GPU look all confirmed in the app window. Deferred (non-blocking): literal-4K backing buffer not run (`phase4-graph`, `phase4-webgpu`). |
| A6 | Any CC session read/modify lights up node (read=violet pulse, modify=rose flare); Activity pane streams all sessions | ✅ | **M1 (transcript-tail) BUILT + test-proven; M2 (global hook) NOT BUILT — plan only.** Read-only tail of `~/.claude/projects/**/*.jsonl` → scoped `ActivityEvent` (in-vault `rel` / **external carries NO path — structural redaction at the Rust source**) → bounded drop-oldest ring + partial-line buffering + rotation resync; in-vault paths pulse nodes (read=violet/modify=rose, tokens), external = muted path-free rows; Activity-pane **health row** (liveness · in-vault·external tally · dropped · **drift/anomaly** count). Tail is opt-in (started by the pane, stopped on unmount, generation-gated against StrictMode race). Re-runnable: `cargo test activity` (12 — torn-line/rotation/`..`-escape-fail-closed/external-pathless/anomaly/generation), `vitest src/activity src/graph/GraphRenderer` (9 — ring + case-folded node lookup), 3-lens adversarial review applied (all 7 findings fixed + regressions). **M2 hook = ARM/DISARM BUILT (gated write — commit `e829835`).** `installer.rs` `arm_install`/`disarm` re-validate every existing hook survives (set-equality, re-checked on the SERIALIZED bytes) → timestamped backup FIRST → atomic temp-write+fsync+rename; idempotent; disarm refuses to drop any non-rose command. Exposed via `activity_hook_arm`/`activity_hook_disarm` + a **Settings → activity-hook section** (Dry-run / Arm-behind-`window.confirm` / Disarm) so the user performs the live write themselves, informed, with the backup path returned. Tested on a TEMP copy (`arm_then_disarm_round_trips_on_a_temp_copy`); live dry-run read-only confirmed **20 hooks preserved +1, round-trips** (`installer -- --ignored`). The live `settings.json` write itself = the user's explicit in-app Arm click (ADR-20260617). ✅ **User walkthrough confirmed live (2026-06-18):** Activity pane on a sanitized vault (`rg-test-vault`) streamed real CC sessions and in-vault nodes flared (read=violet / modify=rose); external rows path-free; health row ticked. M2 live-hook arming remains the user's optional, attended in-app click — M1 transcript-tail covers A6 (`phase8-activity`). |
| A7 | Embedded terminal runs Claude Code + arbitrary commands, cwd=vault | ✅ | Glass drawer (Ctrl+\`) hosts a real shell via portable-pty/ConPTY at cwd=vault. Mechanism re-runnable: `cargo test terminal` (PTY spawn+read spike + `resolve_cwd`); drawer render `docs/proof/phase7-terminal-drawer-web.png`; **end-to-end user-confirmed live: Ctrl+\` then `claude` + `dir` ran at cwd=vault** (`phase7-terminal`). |
| A8 | In-app editing & viewing (lossless-only writes — ADR-20260617): md/txt edit via CM6; PDF view-only; docx view + edit-as-sibling-md; installer registers `.md/.txt/.pdf` | ✅ | CM6 editor (live-preview decorations, path-safe atomic read/save, nav, autosave/anti-clobber — `phase3-editor`). **Phase 9 engines BUILT + 3-lens-reviewed (commit `40d756f`):** PDF renders **read-only** via PDF.js/pdfjs-dist v6 (worker bundled LOCALLY, `enableXfa:false`, `useWasm:false`; v6 dropped `isEvalSupported` so the eval surface is gone) — **never written**; `.docx` renders **read-only** via mammoth→HTML (DOMPurify-sanitized: remote-`<img>` beacons stripped, external links open in the OS browser, not the app frame) + **"Edit as Markdown"** extracts a sibling `.md` through the existing save path (the `.docx` is **never mutated**; re-extract opens the existing sibling, never clobbers edits). New `read_file_bytes` IPC = vault-relative (`safe_join`) + `is_file` + bounded read, raw **ArrayBuffer** (not `number[]`), touches only the `vault_root` lock (never the DB `Mutex`). Open-file dialog routes by `editorKind`; viewers lazy-split (pdfjs/mammoth/dompurify off the critical path). **NO** docx writer/TipTap/MuPDF/pdf-lib; **NO** binary FTS indexing (deferred — ADR guard layer); **NO** new OS association. Spike 11/11 (pdf-lib/pdfjs/mammoth mechanisms); 3-lens review 14/14 fixed (HIGH sibling clobber, docx zip-bomb cap, beacon/nav hardening). Gates: `tsc` 0 · `vitest` **56/56** · `cargo` **52/52** (+3 `#[ignore]`d) +9 mcp · `clippy` 0 · `vite build` 0. ✅ **User walkthrough confirmed live (2026-06-18):** in-app PDF + docx render confirmed in the app window; "Edit as Markdown" produced a sibling `.md` with the `.docx` unmutated. The `.md/.txt/.pdf` OS-associations are declared in `tauri.conf.json` (`.docx` is excluded by-design — lossless-only, ADR-20260617) (`phase9-formats`). |
| A9 | External MCP client can `search` + `get_semantic_clusters` | ✅ | `rose-glass-mcp` bin — a read-only MCP server (JSON-RPC 2.0, MCP 2025-06-18) over stdio. Re-runnable: `cargo test` (9 mcp dispatch tests) + the e2e stdio transcript `docs/proof/phase10-mcp-session.txt`. An external client configures it (`claude mcp add rose-glass -- rose-glass-mcp --vault <dir>`). **Both tools live** — `get_semantic_clusters` now returns real data (Phase 11 fills `clusters` via local neural embeddings + k-means) (`phase10-mcp`, `phase11-clusters`). |
| A10 | Reskin (edit `tokens.css`) re-themes app **and** graph, no component edits | ✅ | The `[data-theme=light]` block re-themes the whole app + the canvas graph (via `resolveGraphTheme()`) with zero component edits: `phase1-shell-{dark,light}.png`. **Reinforced in Phase 6**: the full light-theme tune lives entirely in that token block; the graph-over-backdrop translucency rides the token path (`bgRgb`); even the liquid-glass lens tint reads `--rose` from tokens (no component hardcode — review fix). Formal third-theme experiment still open. |
| A11 | Taste pass confirms hand-built, not templated | ✅ | Phase 6 built the living backdrop + glass + tuned light theme mockup-faithfully (token-driven, no AI-purple/templated defaults; anti-pattern #10 honored — the spec's own locked backdrop, not Impeccable defaults): `phase6-*` proof shots (`phase6-glass`). **Formal `/impeccable` pass DONE (2026-06-18)**: anti-slop verdict **PASS** — distinctive, intentional, hand-built (none of the absolute bans; glass is purposeful chrome over the living backdrop, not decorative cards). Soft spot noted (light-graph cluster auras muddy on the rose field — a taste dial, left to the user). ✅ **User visual-acceptance confirmed live (2026-06-18):** backdrop + glass + both graph themes accepted as hand-built, not templated (a11y `--text-3` fix applied). The binding Phase-6 carve-out is satisfied. |

## Post-v1.0 v2.x shipped (UI polish + branding) — PR #1 (v2.0), PR #2 (v2.1+v2.2)
**v2.0** (PR #1, merge `f62d741`): drag-drop ingest · customizable graph panel · home-dir
`ignore`-crate indexing · embed durability (model cache + retry + telemetry + version purge) ·
real CSP + canonical vault root + threat model · PTY ring buffer + watcher coalesce · signed
NSIS/MSI installer (CN=Dylan N). ADR-20260618-rose-glass-v2-architecture.

**v2.1 + v2.2** (PR #2, merge `2470fb1`, 12 commits). Gates green: `tsc` 0 · `vitest` 95/95 ·
`cargo` 75/75 · `clippy` clean for our diffs (the `embed.rs large_enum_variant` warning is
pre-existing) · `vite build` 0.
- **v2.1** (ADR-20260619-rose-glass-v2.1-ui-fixes): terminal clipboard shortcuts (right-click
  copy-if-selection-else-paste; Ctrl+C copies only with a live selection else stays SIGINT;
  Ctrl+V / Ctrl+Shift+C·V; "copied" pill; default shell cmd.exe→PowerShell + bracketed-paste
  safety + trailing-newline strip) · attention dot rose-circle→emerald-square + pulse on settled
  unattended terminal output (~400ms), clears on refocus · resizable graph/editor split +
  terminal-drawer height (hand-rolled `<Splitter>`, sizes persisted+clamped, rAF-coalesced PTY
  resize). The Session split/height fields left unstaged in `0f183af` are folded in (`362b05a`).
- **v2.2** (spec `docs/superpowers/specs/2026-06-19-rose-glass-v2.2-design.md`): graph
  "solar-system" centripetal `centerPull` (default 0.0015, new "center hold" slider) · lazy
  `TerminalPane` (boot chunk 1104→771 kB, xterm out) · `React.memo(GraphPane)` (insurance) ·
  container queries (`.note-meta` wraps + breadcrumb collapses by pane width) · one curated
  in-repo `<Icon>` set (`src/icons/Icon.tsx`, ~21 paths, 16 render sites swapped, IconRail
  aria-labels) · single-instance file-open forwarding (`tauri-plugin-single-instance`, open-file
  event, +docx association, reuses v2.0 drag-drop ingest).
- **Branding**: app icon → rose-bouquet via `tauri icon` (full PNG/ICO/ICNS + Windows Store set,
  `392548b`).

**v2.3** (PR #3, merge `4487364`, 26 commits; tagged `v2.3` @ `0.3.0`, bump `02ce2bc`; signed
0.3.0 NSIS+MSI). Gates green: `tsc` 0 · `vitest` 119/119 · `cargo` 75/75 · `vite build` 0. Built
brainstorm→spec→plan→build per leg; leg 4 via `/council` (**ADR-20260619-rose-glass-v2.3-tabs-architecture**).
- **Leg 1 — settings:** categorized menu (General/Editor/Behavior/Advanced) + `SettingsContext`;
  live CodeMirror compartments for spellcheck, auto-pair brackets, auto-pair Markdown, smart lists,
  indent tabs/spaces, **vim** (`@replit/codemirror-vim`), **HTML→MD paste** (`turndown`, Ctrl/Cmd+Shift+V=raw).
- **Leg 2 — graph:** hover→highlight node+1-hop neighbors + dim rest; **labels on hover** (forgiving
  22px hit radius, headless-verified); removed the All/Focus toggle. **Ghost nodes tried + reverted**
  (≈1100 vs ≈130 on a real vault — too noisy; `1bb453f`). GPU/2D choice now **persists** (`d63d804`).
- **Leg 3 — reading mode:** Edit/Read toggle (book icon) + read-only rendered Markdown (`markdown-it`
  + DOMPurify, lazy-split, clickable wikilinks); the "Default view" setting drives it.
- **Leg 4 — tabs (ADR-20260619):** multi-document tab bar; the single editable buffer + path-keyed
  save machinery stay UNCHANGED; pure tested `shell/tabs.ts` owns the list transitions (dedup-by-path,
  neighbor-on-close, focus policy); per-tab edit/read mode. R2 (close-flush) automatic via openNote;
  R3 (awaitable flush) done; R1 (shutdown flush) deferred (pre-existing gap).
- **Leg 5 — general:** version + Check-for-Updates (opens GitHub releases); in-app **Help** overlay
  rendering a guide through the reading view (deviation from a bundled help.pdf — PdfView is
  vault-relative only).

## Agent interface (MCP) shipped (ADR-20260623) — ✅ MERGED to master 2026-06-23 (PR #4, merge `78b4c6b`)
Wires Rose Glass as the agent-facing KB: Claude Code navigates + captures via the **read-only
`rose-glass-mcp` stdio sidecar** instead of ripgrep + sequential file reads (works app-closed — the
client spawns it). Built discovery (`docs/agent-interface-findings.md`) → `/council` (ADR-20260623) →
phased plan (`docs/superpowers/plans/2026-06-23-rose-glass-agent-interface.md`) → TDD execution: 6
phases, 14 atomic commits, **two 3-lens adversarial reviews** (Phase 1 + Phases 2-5), all fixes applied.
- **Read tools (always):** `search` · `get_note` · `manifest` (whole-vault triage, flags missing
  summary) · `related` (model-free KNN, `ready:false` when un-embedded) · `get_semantic_clusters` ·
  `maintenance_report` (orphans/stale/missing-summary, self-link-aware).
- **Write (`--allow-write` only):** `upsert_note` — mandatory summary, **inbox-only + markdown-only**
  confinement, dedup-on-create (never clobbers), file-first so the row is **derived** (A3 holds). The
  default invocation opens the DB `READ_ONLY` and never advertises the tool → read-only is provable.
- **Lifecycle:** startup mode log + `--check` doctor (exit 0/1/2). Client config via `.mcp.json`
  (`docs/agent-interface.md`). No network, no model in the sidecar (free-text-semantic-over-MCP +
  RRF fusion deferred per ADR).
- **One confined write fn** `capture::write_note` (file → atomic temp+fsync+rename →
  `pipeline::incremental`); `capture::{build_markdown` (serde_yaml_ng — escapes/round-trips frontmatter),
  `derive_rel, dedup_rel}`; `queries::{manifest, related, maintenance_report}`; the `rose-glass-mcp`
  `--allow-write` gate + dispatch.
- **The reviews caught real bugs.** R1: backslash paths escaped `should_skip` and `create_dir_all` ran
  before validation (dirs created OUTSIDE the vault, probe-confirmed) + hand-rolled YAML silently
  dropped frontmatter on ordinary values. R2 (HIGH): `upsert_note path=` accepted any extension/location
  → arbitrary in-vault file overwrite + A3 divergence (incremental indexes non-md, full_rebuild skips it)
  → fixed by inbox-only + markdown-only enforcement inside `write_note`. Plus a self-link orphan-SQL fix.
- **Gates green:** `cargo test --lib` **96/96** + `--bin rose-glass-mcp` **22/22** · clippy diff-clean ·
  vitest **119** · tsc 0 · vite build 0. **Proven E2E over real stdio:**
  `docs/proof/agent-interface-mcp-session.txt` (a JSON-RPC session: `upsert_note` → the new note is
  immediately surfaced by `search`/`get_note`/`manifest` through the pipe). README + `docs/agent-interface.md` added.
- **Deferred (documented):** `manifest` result cap (a LIMIT would silently truncate a whole-vault triage
  list); free-text-semantic-over-MCP + RRF (needs the model in the sidecar — ADR). Commits `d169f60..2997475`, merged to master via `78b4c6b` (PR #4). *(free-text-semantic-over-MCP since shipped in v2.4.1 — see below.)*

## v2.4 + v2.4.1 — releases + agent semantic search over MCP
**v2.4** (tag `v2.4` @ `0.4.0`, bump `8603cee`; signed 0.4.0 NSIS, CN=Dylan N) — cut the first release
off the merged agent interface (PR #4 above): the `rose-glass-mcp` sidecar shipped in a signed NSIS
installer + a GitHub release with the asset.

**v2.4.1** (merge `dc86f21`, tag `v2.4.1` @ `0.4.1`; signed 0.4.1 NSIS; built on `feat/mcp-fk-and-reembed`
via /council 5-seat/2-round → TDD; **ADR-20260624-rose-glass-mcp-freshness-semantic**). Closes the
embedding-freshness gap that left `related` returning `ready:false` in app-closed agent sessions
(embeddings are written only by the app's manual Clusters button), and adds free-text semantic search.
- **`reembed`** (`--allow-write`) — full-corpus recompute reusing the SINGLE embedding writer
  `cluster::store_clusters` (no second/incremental write-semantics); a **skip-if-fresh** guard
  short-circuits BEFORE loading the ~90MB model; returns `{reembedded, note_count, embedded_before,
  embedded_after, model}`.
- **`semantic_search(query)`** (`--allow-write`) — free-text semantic ranking (embed the query +
  cosine over stored vectors, reusing the pure `knn`). Advertised **only** under `--allow-write`, so the
  default read-only sidecar stays provably model-free. `ready:false` until `reembed` has run.
- **`db::open_indexed(path, Mode)`** — one mode-aware connection constructor; the sidecar now opens its
  DB the same way as the app/tests (FK ON + busy_timeout; WAL/synchronous when read-write). NOTE: a
  flagged "FK-off bug" was a **FALSE ALARM** — the bundled SQLite (`libsqlite3-sys`,
  `SQLITE_DEFAULT_FOREIGN_KEYS=1`) already defaults FK ON (proven by test); this is defensive hardening,
  NOT a corruption fix (v2.4 never orphaned rows).
- **Deferred (per ADR):** RRF hybrid fusion (the agent blends the two ranked lists itself), incremental
  embedding on the watcher (ADR-20260618 forbids ONNX in the hot save path), frontmatter-lint /
  inbox-rollup mutators.
- **Gates green:** `cargo test --lib` **98** + `--bin rose-glass-mcp` **31** (10 new model-free tests +
  a real-model E2E proving `reembed` then `semantic_search("recipe for dinner")` — zero keyword overlap
  — ranks a cooking note top) · clippy clean · tsc 0 · vite build 0. `docs/agent-interface.md` updated.

## v2.5.0 — reactbits.dev visual layer
**v2.5.0** (merge of `feat/reactbits-ui`, tag `v2.5.0` @ `0.5.0`; signed 0.5.0 NSIS, CN=Dylan N).
A frontend-only polish pass integrating seven [reactbits.dev](https://reactbits.dev) components via
`/impeccable` — fit decided per-component, NOT literal drop-ins (most reactbits would be slop in this
design language). All token-driven + reduced-motion-aware; one new dep (`motion`), no gsap. Each
verified live in the browser (vite, mock graph, BOTH themes).
- **DotField** behind the graph — cursor-reactive dot grid (ported to strict TS); colors resolved from
  tokens (`resolveGraphTheme`); `pointer-events:none` so it never steals pan/zoom; omitted under
  reduced-motion; alpha tuned to read through the renderer's 0.4 field.
- **Dock magnify** on the 52px icon rail — adapted row→column with `motion` springs (34→46px, fits the
  rail), reduced-motion pins to base; kept the rail layout + rose active indicator.
- **Border-glow** on action buttons — button-scaled cursor-tracked ring (one delegated pointermove
  listener feeds `--gx/--gy` to a masked `::after` on `.gc-btn`/`.tb-btn`/`.ea-btn`); excludes the rail
  (now a dock) + the titlebar window controls.
- **List reveal** on Notes/Tags — staggered fade+rise on `.sp-row` mount (CSS, visible-by-default — no
  JS-gated visibility, so no blank-pane risk).
- **Count Up** statusbar metrics (motion spring, 0→value, delta on change), **Split Text** per-word
  note-title reveal (keyed by path → replays per open; aria-label keeps it screen-reader-correct), and
  a **terminal slide** on Ctrl+\` (translateY+opacity only, so the height-resize splitter is untouched;
  `inert` when closed).
- **Decisions (via AskUserQuestion):** Dock = vertical-on-the-rail (not a bottom bar); BorderGlow =
  button-scaled adaptation (not the full conic-mask card on ~40 buttons). Deferred by the user: a full
  BorderGlow glow-CARD on a floating surface; extending the button-glow to every button family.
- **Gates:** tsc 0 · vite build 0 (Rust/cargo untouched — frontend-only). Live-verified both themes:
  Count Up lands 22/48/8, title reveals, the terminal slides up on Ctrl+\` and back down.

## v2.5.1 — in-app motion override (2026-06-25)
**v2.5.1** (branch `fix/motion-override`, commits `85ed311` + `80b6aa0`; bump `0.5.0`→`0.5.1`; signed 0.5.1
NSIS + MSI, CN=Dylan N). Bug-fix. The v2.5.0 effects above all read `prefers-reduced-motion`, which on
Windows IS the "Animation effects" toggle (Settings → Accessibility → Visual effects) — users flip it for
snappiness, not only accessibility. With it OFF, WebView2 reports reduce=true and all six correctly
self-disabled (not a build regression). Confirmed via Win32 `SPI_GETCLIENTAREAANIMATION` (exactly what
Chromium/WebView2 reads); two gotchas surfaced — toggling the OS setting ON does NOT fix an already-running
app (WebView2 caches it per-process; needs a full restart), and `GraphPane` read the value once in a
`useState` initializer so DotField could never recover on a live change.
- **One source of truth** (`src/appearance/motion.ts` + `useReduceMotion.ts`, mirrors `theme.ts`'s
  defined-once pattern): combines the OS signal with a new persisted **Animations** setting and reflects the
  result onto `<html data-reduce-motion>`. EVERY reader routes through it — the four `motion/react`
  `useReducedMotion()` consumers (IconRail/CountUp/SplitText/Shell), GraphPane's canvas `matchMedia`, the
  Backdrop, and all six CSS `@media (prefers-reduced-motion)` blocks (flattened to `:root[data-reduce-motion='1']`
  descendant rules — higher specificity + later source order, verified).
- **Settings → General → Animations:** Follow system / Always on / Off (default **Follow system** — the prior
  accessibility behavior is byte-for-byte preserved; enum-guarded in `mergeSettings`). **"Always on"** makes
  `resolveReduceMotion('on',…)=false` unconditionally → motion regardless of the OS toggle or any WebView2
  staleness. Also fixes DotField's once-read bug (now live via `useSyncExternalStore`).
- **Gates:** vitest **122** (+ `appearance/motion.test.ts`) · tsc 0 · vite build 0. **3-lens adversarial
  review = ship / 0 findings** (a11y fail-mode: `index.html` has only `<div id=root>` so no static gated
  markup + `initMotion` runs before first paint → no fail-open; CSS specificity; completeness/no-cycle).
  Signed 0.5.1 NSIS + MSI built + `Get-AuthenticodeSignature` Valid, CN=Dylan N. Branch pushed-pending —
  NOT yet merged/tagged.

## Phase 12 — §20 acceptance gate PASSED → v1.0 (2026-06-18)
**All 11 §20 rows ✅ proven.** A3/A4/A7/A9/A10 were headless/test-proven earlier; the 6
live-window rows (A1/A2/A5/A6/A8/A11) are now confirmed by the **user's live walkthrough**
(2026-06-18) — the binding eyeball that, by ADR-20260616's verifiability constraint, only the
user can give (boots-clean, graph feel + Focus + GPU, real CC-session activity streaming on a
sanitized vault, live PDF/docx render, visual-taste acceptance). All headless gates green at the
tagged commit: `tsc` 0 · `vitest` 73/73 · `vite build` 0 · `cargo test` 71 (+3 `#[ignore]`d) ·
`clippy` 0 · A2 visual 4/4. The tree also carries the post-v1.0 Phase-13 semantic-search add.
Not arming M2 (the live `~/.claude/settings.json` write) stays the user's optional attended act —
M1 transcript-tail satisfies A6. **Tagged `v1.0`.**

## Phase 13 shipped (semantic search — brute-force cosine KNN; post-v1.0 addition)
- **`/council` → ADR-20260618** (5/5 seats): **brute-force cosine KNN in pure Rust** over the existing `embeddings` BLOBs, **NOT the sqlite-vec C extension** — the 384-dim vectors already live in-Rust and a linear scan is sub-perceptible for a personal vault; sqlite-vec/HNSW is the named upgrade past ~100k notes + a *measured* latency regression. The council's load-bearing find: `embeddings` is written ONLY by the manual `recompute_clusters`, never the incremental indexer → a **freshness contract** so KNN never silently ranks a stale/partial corpus.
- **Pure core** (`knn.rs`): TRUE cosine `dot/(‖a‖·‖b‖)` (no pre-normalization assumption), top-k descending, self-match exclusion, NaN/zero/dim-mismatch/empty/k-clamp guards — 6 unit tests.
- **Read path** (`queries.rs`): `read_embeddings(conn, model)` (model-filtered, blob decode) + `embedding_freshness(conn, model)` (model-filtered count proxy) + `titles_for`. **Two IPC commands** (`commands.rs`): `related_notes(path,k)` — MODEL-FREE (the note's vector is already stored; pure DB scan under one lock) — and `semantic_search(query,k)` — embeds the query (per-call ONNX, ponytail-ceiling-marked → cache in AppState if latency bites), lock-split like `recompute_clusters`. Both clamp `k` and surface `ready`/`stale`.
- **Frontend**: a "Related" list in the editor (`EditorPane`, reuses backlinks markup) — model-free, self-heals on `index:rebuilt`, surfaces the "recompute to enable" empty-state per the freshness contract. `semanticSearch` exposed in the typed IPC client.
- **Deferred (decisions.md #8)**: an MCP `search_semantic` tool (no external caller yet; FTS `search` already serves the sidecar) + AppState model-caching for free-text search.
- **3-lens adversarial review** (correctness / robustness+security / spec-fidelity): no HIGH; all confirmed findings fixed — model-filtered freshness count, `k`/`query` IPC bounds, the `ready=false` UI empty-state, self-heal-on-recompute, the stale sqlite-vec doc references reconciled.
- **Proven**: `cargo test` **71** (62 lib +9 mcp; +9 new: 6 knn + 3 semantic DB) · clippy 0 · tsc 0 · vitest 73/73 · vite build 0. **Real-model end-to-end** (`#[ignore]d`, ran green): "how do I cook pasta" ranks the cooking note above an astrophysics note via actual all-MiniLM embeddings + cosine KNN — `cargo test semantic_search_ranks_topically_with_real_model -- --ignored`. The LIVE in-app "Related" feel = app-window eyeball.

## Phase 9 shipped (editor engines — lossless-only; live render eyeball-pending) — commit `40d756f`
- **Council → ADR-20260617** (5 seats, 2 rounds): lossless-writes-only. The decider — the codebase already *refuses to open a file it can't write back faithfully* (`commands.rs` strict-UTF-8), so any binary *writer* (pdf-lib re-serialize / docx rebuild) is that forbidden op one layer up. v1 writes only md/text; every binary is view-or-sibling. Dropped vs the original scope: pdf-lib, a docx writer, TipTap/ProseMirror, MuPDF WASM, binary content indexing.
- **Spike-first (11/11)**: pdf-lib edits+saves a valid PDF (capability ≠ faithfulness — hence view-only); pdfjs-dist extracts text in Node + renders in Edge; mammoth is read-only (no writer) → docx write-back is a lossy rebuild. `mammoth.convertToMarkdown` proven for the sibling extraction.
- **PDF = view-only** (`PdfView.tsx`, PDF.js/pdfjs-dist v6): worker bundled **locally** via Vite `?url` (no CDN — §2.1), `enableXfa:false`, `useWasm:false` (pure-JS decode, no wasm asset); v6 **removed `isEvalSupported`** so the eval surface no longer exists. HiDPI (dpr baked into render scale), race-safe load/teardown (`loadingTask.destroy`). Never writes a PDF.
- **docx = read-only view + edit-as-sibling-md** (`DocxView.tsx`): mammoth→HTML, **DOMPurify-sanitized** (scripts/`javascript:` blocked by default; added: remote-`<img src>` beacons stripped so an untrusted docx can't phone home, anchors `rel=noopener` + clicks routed to the OS browser so a link can't navigate the app frame away — `csp:null`). **"Edit as Markdown"** = `mammoth.convertToMarkdown` → sibling `<name>.docx.md` via the existing atomic save → opens in CM6 → watcher indexes it (graph node). The `.docx` is **never mutated**; re-extract **opens the existing sibling, never clobbers** hand edits. docx size cap (25 MB) mitigates zip-bombs (residual crafted-bomb OOM is renderer-only/recoverable — full guard deferred per ADR).
- **`read_file_bytes` IPC** (`commands.rs`): vault-relative `safe_join` + `is_file` + bounded `take(MAX+1)` read (TOCTOU-safe, 100 MB cap), raw **ArrayBuffer** via `tauri::ipc::Response` (not a bloated `number[]`), touches only the briefly-held `vault_root` lock — **never the DB `Mutex`** (no DoS-on-lock). Open-file dialog (`Shell.onOpenFile`) routes by `editorKind`; binaries must live inside the vault (`toVaultRelative` UI gate, re-validated by `safe_join`).
- **Pure helpers tested** (`fileOpen.ts`: `toVaultRelative`/`siblingMdPath` — `vitest` 7). Viewers **lazy-split** (pdfjs/mammoth/dompurify off the critical path; main chunk 2.0 MB→1.1 MB). **No** binary FTS indexing (indexer untouched), **no** new OS association (`.pdf` stays `Viewer`, no `.docx`).
- **3-lens adversarial review: 14 findings, all confirmed + fixed** — HIGH: re-extract silently overwriting an edited sibling `.md` → existence-probe open-not-overwrite. MED: DocxView path-switch race → `key` remount; docx zip-bomb → size cap + ceiling. LOW: `read_file_bytes` TOCTOU/`is_file` → bounded read; remote-img beacon + link-nav hardening; silent open-file rejection → disable when no vault; stale MuPDF/TipTap comments; dead `formatLabel` removed.
- Gates: `tsc` 0 · `vitest` **56/56** · `cargo` **52/52** (+3 `#[ignore]`d) +9 mcp · `clippy` 0 · `vite build` 0.
- **Binding remaining (user eyeball, A8): the LIVE in-app PDF/docx render** — the render needs Tauri IPC so it isn't headless-verifiable; not claimed proven (no `device.ts` trap). Formal `/impeccable` live polish folds in once the viewers are confirmed rendering.

## Phase 4 shipped (graph interaction + WebGPU renderer — GPU render eyeball-pending)
- **Interaction (verified):** wheel zoom-to-cursor, drag-pan, drag-node (pinned during drag), click-to-open. Built renderer-agnostic on three pure, tested modules — `camera` (world↔screen), `hitTest` (nearest-node), `simulation` (the mockup force model extracted as a **seedable `stepSimulation`** so 2D + WebGPU share one deterministic layout; ADR-20260616's "seedable Simulation"). `vitest src/graph/interaction` (9) + `GraphRenderer.test` (node lookup). The canvas-2D `draw()` now applies a camera transform (screen-space bg/wash, world-space content; HiDPI-crisp).
- **WebGPU primary (BUILT, NOT GPU-VERIFIED):** `WebGpuGraphRenderer` — instanced node discs (circle SDF) + edge lines, same camera/layout/activity-pulse; `@webgpu/types` validates the full API surface at `tsc`. Opt-in via a graph-header **GPU/2D toggle** gated on a real `probeWebGpu()` (adapter+device obtainable).
- **Airtight fallback (§17):** `create()` returns `null` on ANY init failure (no adapter/device, pipeline validation via `popErrorScope`, throw) → caller keeps canvas-2D. Per-backend canvas **`key` remount** so the 2D fallback never inherits a `webgpu`-committed canvas (the HIGH review finding). Device-loss (`device.lost` / mid-frame throw) → `onLost` → flip to 2D. GPU resources destroyed on teardown/failure. **A GPU failure can never blank or break the graph.**
- **3-lens adversarial review:** 10 findings, all confirmed, all fixed (1 HIGH fallback-blank, 2 MEDIUM device-loss, 7 LOW: device leak, frame guard, probe re-run reshuffle, resize-during-build, positional pulse lookup, stale edge verts, fidelity divergence). Gates: `tsc` 0 · `vitest` **46/46** · `vite build` 0 · `cargo` **52/52**.
- **GPU VERIFICATION DONE (2026-06-17):** driven via headed Edge (= the app's WebView2 engine) against the web build on the RTX 5090 — probe returned adapter `nvidia/blackwell`, the GPU toggle built + stayed "GPU" (shaders/pipelines validated, no fallback), the graph rendered, and wheel-zoom worked. Proof: `docs/proof/phase4-webgpu-{render,zoom}.png` (+ `phase4-2d-render.png` baseline) via `phase4-webgpu-verify.cjs`. d3-force-vs-mockup-physics decision recorded (decisions.md #9).
- **GPU VISUAL PARITY (2026-06-17), scope `phase4-webgpu`:** the previously-leaner GPU path was grown to the full 2D look. Riskiest-premise spike FIRST — the only non-trivial GPU-feeding math is curved thick edges (WebGPU has no curve primitive and `line-list` is a hardware-1px line), so `ribbon.ts` tessellates each quadratic into a constant-width triangle ribbon, pure + unit-tested 8/8 (winding, miter, degenerate-fallback, buffer-cap) BEFORE wiring the GPU. Then `WebGpuGraphRenderer` rebuilt on **3 instanced pipelines** — `sprite` (per-instance softness ⇒ soft glow vs hard disc; a screen-space flag for the ambient wash), `ring` (annulus SDF), `ribbon` — with a per-frame CPU scene-build that replays `GraphRenderer.draw()`'s exact formulas in back-to-front draw-op order, so the layering matches the immediate-mode 2D path. Added: cluster auras/glow, curved edges + arrowheads + trail overlays, tributary particles (with the particle system + tick), hub concentric rings + orbiting dots, the **theme bullseye inversion** (rgbC/coreFill swap), and **`setFocus`** (was a no-op — now the same 1-hop dim as 2D, id≡index). **Skipped:** hub text labels (glyph-atlas on GPU is disproportionate — documented ponytail ceiling; the 2D path keeps labels and is default). 3-lens adversarial review: **7 findings, all LOW, all fixed** — slime control-point off-by-one vs 2D, init moved under a validation+OOM error scope (an over-limit buffer now returns null → clean 2D fallback, not a first-frame surprise), one-shot device-loss (frame() catch + device.lost can't double-fire), cached slimeMax, wash radius `W*0.45`. Re-verified post-fix on the 5090 (still GPU dark+light, 0 errors). Gates: `tsc` 0 · `vitest` **67/67** (+8 ribbon) · `vite build` 0 · A2 visual **4/4** (no baseline shift — the 2D chrome is untouched).

## Phase 8 shipped (CC activity mirror — M1 transcript-tail; M2 deferred per ADR-20260617)
- **Council → ADR-20260617** (5 seats, 2 rounds, unanimous): mechanism = **M1 transcript-tail ONLY**; the live `~/.claude/settings.json` write **deferred** (the one unrecoverable-if-botched unattended action — kept for an attended morning step). All binding conditions captured: structural redaction, bounded ring, health row, no-`fs::write` installer plan.
- **Spike-first** (riskiest premise): incremental tail of a growing `.jsonl` with a **deliberately-torn final line** parsed without throwing + rotation resync + `..`-escape fail-closed — `cargo test activity` (12). Reuses the Phase-2 `notify-debouncer` watcher pattern; zero new infra.
- **Structural redaction at the source:** the `External` `ActivityEvent` variant has NO path field — an out-of-vault `file_path` never crosses the IPC boundary (stronger than a render-time strip; a type that can't hold the value can't leak it). In-vault classification is lexical + case-folded (Windows) + fails CLOSED on `..` escape; the emitted `rel` keeps CC's reported case and the frontend node lookup is case-folded so a casing divergence still flares the node (review fix F1).
- **Node light-up + pane:** in-vault read=violet pulse / modify=rose flare (decaying flares in `GraphRenderer`, colours from `--violet`/`--rose` tokens); external sessions stream as **muted, path-free** rows (§24); the **health row** surfaces liveness / in-vault·external tally / backend-dropped / **schema-drift (anomaly)** count so a silently-dead or drifted tail is visible. Tail is opt-in (started by the pane), ephemeral (§19.9 — no DB, no disk log), generation-gated start↔stop (review fix F2/F7).
- **M2 installer = PLAN ONLY (`installer.rs`):** computes the merged settings + **set-equality-validates** every existing hook command (not a count — catches a silently-dropped safety hook) + uninstall round-trip, with **no `fs::write` anywhere**. Proven against the **live** settings.json read-only (`-- --ignored`): **20 hooks preserved + round-trips**.
- **3-lens adversarial review** (correctness/robustness+security/spec): 7 findings, all confirmed, all fixed (case-fold lookup, generation-gated tail, dead-branch removed, partial-buffer cap, tailer eviction, drift counter) + regression tests. Gates: `cargo test` **52/52** + `clippy` 0 · `tsc` 0 · `vitest` **36/36** · `vite build` 0.
- **Binding morning eyeball (A6):** run the app, open the Activity pane on a **sanitized** vault, confirm real CC sessions stream + in-vault nodes flare. Arming M2 (live hook) is a separate attended, user-OK'd act.

## Phase 11 shipped (local neural embeddings + semantic clusters)
- **Local ONNX embeddings** (all-MiniLM-L6-v2 via fastembed/ort) — offline after a one-time ~90MB model fetch; 384-dim f32 vectors stored as BLOBs in the `embeddings` table. **Spike proven** (the riskiest premise): ONNX builds + the model downloads + infers on Windows — `cargo test embed_spike_produces_384dim -- --ignored`.
- **Deterministic k-means** (`cluster.rs`) → `clusters` table. The full pipeline is proven **semantically** with the real model: `full_pipeline_separates_topics_semantically` (cooking notes vs astrophysics notes land in different clusters) — `cargo test ... -- --ignored`.
- **Lights up existing consumers, zero frontend rework:** the graph colours by cluster (`get_graph_payload` LEFT JOINs `clusters`) and the Phase-10 MCP `get_semantic_clusters` now returns real data. Triggered by the graph-header **Clusters** button → `recompute_clusters` command (lock-split: read texts under the DB lock, embed **unlocked**, store under the lock; emits `index:rebuilt` → graph refetch/recolour).
- **sqlite-vec deferred** — vector KNN *search* is a later feature; vectors live as a BLOB and are read back into Rust for clustering. **k=4** matches the graph's 4-colour palette (capped to note count).
- **3-lens review** — both findings fixed: `store_clusters` skips paths deleted mid-recompute (`WHERE EXISTS`, so a concurrent delete no longer FK-rolls-back the whole run); `embed_texts` borrows `&str` (no second copy of the corpus). Lens-3 clean.
- Gates: `cargo test` **41/41** + `clippy` 0 (deterministic k-means + BLOB-codec + store/skip tests; the two real-model tests `#[ignore]`d) · `tsc` 0 · `vitest` 27/27 · `vite build` 0. Live recompute on a real vault is user-verifiable (the Clusters button; first run downloads the model).

## Phase 10 shipped (read-only MCP sidecar)
- **`rose-glass-mcp`** (a second bin in src-tauri): a JSON-RPC 2.0 server (MCP protocol **2025-06-18**, verified against the official spec) over **stdio**, exposing two read-only tools over the vault's `index.db`:
  - `search(query)` → FTS5 hits (reuses the canonical `queries::search_fts`);
  - `get_semantic_clusters()` → clusters grouped by id (new `queries::get_clusters`; empty until Phase 11 populates the `clusters` table).
- Opens `<vault>/.rose-glass/index.db` **READ-ONLY** (`SQLITE_OPEN_READ_ONLY`) — §18 (no write-heavy MCP tools). Reuses `desktop_lib::db` (no SQL dup; `pub mod db`). `--vault <dir>` arg.
- **Proven end-to-end:** real stdio handshake (`initialize` → `tools/list` → `search` → `get_semantic_clusters`, + malformed-request and notification edge cases) against a seeded `index.db` — `docs/proof/phase10-mcp-session.txt`. Dispatch is a pure `handle_request` unit-tested 9 ways.
- **3-lens review** — all findings fixed: `busy_timeout(5000ms)` so a transient WAL-checkpoint `SQLITE_BUSY` (app writing) is waited out, not failed; a malformed/no-method request returns `-32600`; id-less (notification-form) messages get no response; defensive `LIMIT` on `get_clusters`. Lens-3 clean.
- Gates: `cargo test` **35/35** + `clippy` 0. Integration model: an external MCP client (Claude Desktop, `claude mcp add`, etc.) spawns the binary over stdio. App auto-bundling (a Tauri managed sidecar) is a deferred nicety, not required for A9.

## Phase 7 shipped (embedded terminal — xterm.js + portable-pty)
- **Glass terminal drawer** (Ctrl+\`, off by default) hosting a real shell at cwd=vault — runs Claude Code + arbitrary commands (A7). PTY in Rust (portable-pty/ConPTY), xterm.js renders; token-themed (re-themes live), binary-safe `Vec<u8>` I/O.
- **Backend** (`terminal.rs`): `pty_spawn/pty_write/pty_resize/pty_kill` over a session registry; reader thread streams `pty:output` + `pty:exit`; cwd from `AppState.vault_root` (pure `resolve_cwd`, unit-tested).
- **Spike proven** (the riskiest premise): portable-pty spawns a shell + we read its output — `cargo test terminal::tests::pty_echo_round_trip`. Made **self-bounding** (worker thread + `recv_timeout`) because Windows ConPTY doesn't deliver EOF for a one-shot child — so a flaky no-EOF fails fast, never wedges the build.
- **3-lens adversarial review** (correctness/robustness/spec) — all findings fixed: per-session `Arc<Mutex<Writer>>` (a blocking write can't make `pty_kill` unreachable for a hung child); reader-thread session eviction on child exit (no handle leak on self-exit); frontend re-checks `disposed` after each await + unlistens (StrictMode listener leak), guards writes (no write-after-dispose), invalidates id on exit.
- Gates: `cargo test` **26/26** + `clippy` 0 · `tsc` 0 · `vitest` 27/27 · `vite build` 0 · drawer render (Playwright). **End-to-end user-confirmed live** (Ctrl+\`, `claude` + `dir` at cwd=vault).
- Known ceilings (code-commented): the `Vec<u8>→number[]` event byte-bloat (upgrade to base64/Channel if throughput bites); a first-prompt spawn-before-listener race (press Enter for a fresh prompt). Deferred niceties: a "Run Claude Code" button, multiple terminals, persistent scrollback.

## Phase 6 shipped (glass / living backdrop / light-theme tuning)
- **Two locked-stack libs proved dead on React 19 + WebGL by spikes** (the ADR's whole point — caught before building on them):
  - `@shadergradient/react@2.4.20` (latest) bundles react-three-fiber **v8** inline → hard-crashes the app at module load under React 19 (`ReactCurrentOwner` undefined); unfixable (v8 baked into its dist). Compile gates all passed; only the live render exposed it (`phase6-spike`).
  - `dashersw/liquid-glass-js` samples via **html2canvas**, which can't rasterize a WebGL canvas → would break over the backdrop.
- **Backdrop (user-chosen pivot):** hand-written GLSL flowing rose/violet mesh on **@react-three/fiber@9 + three** (React-19-native). Lazy-imported (890KB three.js off the critical path) with **four §17 guards** → static token-driven gradient: reduced-motion, **synchronous WebGL2 probe** (closes the renderer-construction-failure gap r3f's async path leaks past an error boundary — review HIGH fix, unit-tested), Suspense, error boundary. `pointer-events:none` + `aria-hidden`. Colors theme-aware from `colors.ts` (the one sanctioned shader-hex spot; unit-tested).
- **Graph floats in the field:** canvas fills its bg translucent (`GRAPH_BG_ALPHA`, dialed to 0.4) over a transparent `.graph-pane` so the living gradient shows behind the graph; editor stays solid for text.
- **Glass (user-chosen):** chrome stays native `backdrop-filter` (correctly refracts the live WebGL backdrop — `phase6-glass-palette-dark.png`). **eamonliu/liquid-glass-js** (zero-dep, SVG `feDisplacementMap`, native backdrop-filter path) added as a toggleable draggable lens over the graph — off by default, "◎ Lens" control in the graph header; tint reads `--rose` from tokens.
- **Light theme tuned:** the untuned pass kept dark's BRIGHT accents (invisible on light); remapped emphasis bright→deep, raised text contrast, dark graph node-cores (ink-on-paper). Entirely in the `[data-theme=light]` token block (A10 holds).
- **Adversarial 3-lens review:** correctness lens clean; fixed HIGH (§17 WebGL2 gap) + 2 LOW (lens token-hardcode, Canvas aria-hidden), each with regression coverage. Gates: `tsc` 0 · `vitest` 27/27 · `vite build` 0 (three.js lazy-split) · 0 console errors · live WebGL asserted.
- **Pending (binding carve-out):** final visual taste/parity — backdrop opacity (0.8), graph-field alpha (0.4), lens look — flagged for **user eyeball** (A11/A2). The dials are single named constants.

## Phase 5 shipped (Search + ⌘K command palette)
- ⌘K command palette ported from the mockup (`.cmd-palette` glass over a dimmed overlay): debounced FTS `search` IPC, result rows, ↑↓ wrap-nav + Enter-to-open + Esc-to-close + click-to-open, focused-result rose wash.
- Opens via ⌘K/Ctrl+K (global keydown) and the titlebar "⌘K Search" button; selecting a result opens the note (reuses `openNote`).
- Stale-response guard on the debounced search; `clampIndex` unit-tested; full open→type→Esc Playwright E2E. No Rust changes (reuses Phase 2's `search`).
- **Review applied:** ⌘K now open-only at the window level (palette owns its close, so ⌘K-inside no longer toggle-conflicts — E2E re-verified); focus restored to the prior element on close; "Searching…" vs "No results" distinction; `aria-modal`/`role=listbox`/`option`+`aria-selected`; results show the FTS snippet (highlight tags stripped — no XSS). Deferred: full Tab focus-trap.

## Phase 3 shipped (CodeMirror 6 editor)
- CM6 editor host (StrictMode-safe single mount — Playwright `cmCount===1`) replaces the static body; React keeps the breadcrumb/title/meta/backlinks chrome.
- Live-preview decorations (ViewPlugin over visible ranges) for `[[wikilink]]` / `#tag` / `` `inline code` `` — tag regex mirrors the indexer so painted ≡ indexed; verified live via Playwright typing.
- Theme via `EditorView.theme` reading `var(--*)` tokens → re-themes on dark/light flip with zero JS.
- Path-safe IPC: `read_note_file` / `save_note_file` (atomic temp+rename, vault-root canonicalize check — 3 `fs_safe` tests) / `resolve_link` (reuses the indexer's resolution so nav ≡ graph edges).
- Editor host: open-first-note on vault open; Mod/Ctrl-click wikilink + backlink-click navigation; debounced autosave with an anti-clobber guard (never reload the buffer the user is editing; ignore our own save echo) — vitest unit tests.
- **Adversarial review applied:** save-completion race guarded by captured path; empty-state editor is read-only (no silently-discarded typing); `read_note_file` strict-UTF-8 (no lossy round-trip corruption); **CRLF preserved** (LF internally, original EOL re-applied on save — the app never silently reformats a file); decoration tokenizer reorders inline-code before tag (+ pure `scanTokens` tests); delete-of-open-note handled; doc-swap excluded from undo; `save_note_file` fsyncs before rename; `fs_safe` rejects empty/dir targets.

## Phase 2 shipped (vault + indexer + SQLite + watcher + IPC)
- Rust indexer: deterministic markdown parser (frontmatter/wikilinks/embeds/md-links/tags, length-preserving masking so code/URLs are ignored), blake3 content-hash gate, two-pass link resolution, full-rebuild + incremental + delete, FS watcher (notify-debouncer-full) → worker thread.
- SQLite (rusqlite bundled + FTS5), derived-only schema (§8) at `<vault>/.rose-glass/index.db`; WAL + foreign_keys + busy_timeout pragmas; migrate-or-rebuild.
- IPC: `open_vault / get_note / get_backlinks / search (FTS5) / get_tags / get_graph_payload / reindex` + `index:note`/`index:rebuilt` events; typed `src/ipc` client; `payloadToGraphData` mapper feeds the real graph.
- Tests: 16 Rust (parser/resolve/pipeline/A3) + 7 vitest; clippy clean.
- **Pending on resume:** the adversarial review workflow (`phase2-review`) was interrupted by the pause — re-run it before building on this; its script is saved (see resume note below).

## This session shipped (Phase 0 + 1 + 2D-graph leg)
- pnpm workspace + Tauri 2 (React 19 / TS strict / Vite); Rust shell compiles.
- `tokens/tokens.css` copied verbatim from the mockup `:root`; self-hosted Inter + JetBrains Mono (no Google Fonts).
- Shell 1:1 from the mockup (titlebar + traffic-light window controls / 52px rail / split / statusbar).
- Mockup's canvas-2D living graph ported, de-hardcoded (colors from tokens), on mock `GraphData`.
- Live + persisted dark/light theme toggle (light = untuned first pass).

## Known ceilings (ponytail-marked)
- Frameless window: native edge-resize reduced on Windows; upgrade = resize handles / `tauri-plugin-decorum`.
- ~~Graph canvas at CSS-px resolution~~ → **fixed**: the canvas-2D graph now renders its backing store at `devicePixelRatio` (crisp text/graph on HiDPI/4K — verified at dpr 1.5, `phase4-graph`). The deliberately-oversized *fixed-4K* buffer (zoom headroom) still lands with WebGPU (`phase4-webgpu`).
- `favicon.ico` 404 in dev console — cosmetic; add a favicon when chrome is finalized.

### Phase 2 review — deferred (low/speculative or future-phase)
- **mtime gate-1** skips the hash check when mtime is unchanged → a content edit that preserves mtime (coarse FS, mtime-restoring editors) is skipped until a full rebuild. Acceptable perf gate; revisit if it bites.
- **Tags starting with a digit** (`#3d`, `#1password`) are rejected by the TAG regex (requires a leading letter); `norm_tag` keeps a trailing `/`/`-`. Minor index inaccuracy.
- **Path-traversal targets** (`[x](../../etc/passwd)`) parse to dangling (never used as FS paths in P2) — when the link-follow feature lands, canonicalize + assert inside vault root.
- **Symlinked .md files** are indexed under their in-vault relpath (out-of-vault content can enter the index); **non-UTF-8 filenames** are silently skipped (no log). Add observability when it matters.
- **Watcher worker** has no UI health signal if its connection hits a fatal error (errors are now logged, not silently dropped); **mpsc channel** is unbounded under a save-storm. Revisit with the activity pane (Phase 8).

### Phase 3 review — deferred (low/cosmetic or future-phase)
- **Decoration code-fence masking**: a `[[link]]`/`#tag` inside a ``` ``` ``` fence is still painted (the JS tokenizer doesn't mask multi-line fences like the Rust indexer). Cosmetic — clicking resolves via the backend index (real note → nav, otherwise no-op).
- **`index:note` refetch on every save**: each open-note index event does getNote+getBacklinks+readNoteFile+refreshGraph. Debounce/throttle when vaults get large (perf, not correctness).
- **Multi-segment new folders**: `save_note_file` can't create a note in a not-yet-existing nested dir (errors cleanly). Add `create_dir_all` when that workflow lands.
- **Save-failure on rapid switch**: a rejected autosave during a note switch is logged but not retried/surfaced; add a status-bar "save failed" affordance later.
