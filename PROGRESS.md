# Rose Glass — Progress & Resume

Local-first PKM + live Claude Code activity mirror (Tauri 2 + React 19 + TS-strict).
**Repo:** `C:\Users\dnoye\rose-glass` · **private remote** `Vividness9816/rose-glass` · branch `master`.

**Authoritative docs (read these to resume):**
- `STATUS.md` — §20 acceptance ledger (proven / partial / untouched; each `proven` row cites a commit + artifact)
- `ROADMAP.md` — phase plan; commit scopes are `feat(phaseN-...)` so `git log --grep=phaseN` is the resumption index
- `docs/build-instructions.md` — operative spec · `docs/decisions.md` — run decisions
- `docs/design-reference.html` — the **visual contract** (match it, don't approximate)
- ADR: `~/.claude/second-brain/decisions/ADR-20260616-rose-glass-execution-strategy.md` (foundation-first; no fake "verified")

## Done — built · reviewed · verified · pushed
- **Council → ADR** (foundation-first staged execution; the spec's literal 1-shot is unverifiable in one session).
- **Phase 0** — pnpm workspace + Tauri 2 boots + `tokens.css` verbatim from the mockup + live dark/light theme + self-hosted Inter/JetBrains Mono.
- **Phase 1** — shell 1:1 from mockup (titlebar + traffic-light controls / 52px rail / split / statusbar).
- **canvas-2D living graph** (de-hardcoded, token-driven, on mock data) — the §20 2D-fallback leg.
- **Phase 2** — vault indexer + SQLite/FTS5 derived store + `notify` watcher + IPC (open_vault/get_note/get_backlinks/search/get_tags/get_graph_payload/reindex). **A3 delete-DB→rebuild equivalence PROVEN.**
- **Phase 3** — CodeMirror 6 editor: live wikilink/tag/inline-code decorations, path-safe read/save (atomic + strict-UTF-8 + EOL-preserving), backlinks, open-note + nav, debounced autosave + anti-clobber.
- **Phase 5** — ⌘K command palette over FTS search (debounced, keyboard nav, focus-restore).
- Each phase closed with a **3-lens adversarial review** + fixes + regression tests.

**Latest gates (all green):** `cargo test` 24/24 + `clippy` 0 · `tsc` 0 · `vitest` 24/24 · `vite build` 0 · Playwright E2Es (shell render, editor decorations, ⌘K flow). Proof shots in `docs/proof/`.

## Next — these need the user in the loop (why the autonomous run paused here)
- **Phase 4 — WebGPU graph** (4K render + d3-force + drag/zoom/pan/click-open + 2D fallback): the marquee feature; final parity needs a **live-GPU eyeball** on the RTX 5090 (the predecessor's "verified-but-not" trap lives here). Opens with the required spike (React19×design-libs + WebGPU probe + fallback).
- **Phase 6 — glass / shadergradient backdrop**: visual taste + the Impeccable/Taste design gate.
- **Phase 7 — terminal** (xterm.js + portable-pty) · **Phase 9 — MuPDF/docx editors** · **Phase 10 — MCP sidecar** · **Phase 11 — embeddings/clusters** · **Phase 12 — v1.0 gate**.
- **Phase 8 — activity bus**: ⚠ **BINDING SAFETY CARVE-OUT (ADR)** — the global CC-hook install (`~/.claude/settings.json`) + `~/.claude/projects/**/*.jsonl` transcript-tail need **explicit user consent** + atomic backup/validate + `127.0.0.1`-only + secret redaction + uninstall. Do not touch settings.json autonomously.

## Resume / verify
```
cd C:\Users\dnoye\rose-glass
pnpm install
pnpm --filter @rose-glass/desktop tauri dev          # run the app; open a real folder of .md to see indexer+editor+search live
pnpm --filter @rose-glass/desktop exec tsc --noEmit
pnpm --filter @rose-glass/desktop test               # vitest
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Working pattern (what's been succeeding)
design-workflow (big/version-sensitive phases) → inline verified implementation → 3-lens adversarial-review workflow → fix confirmed findings (+ regression tests) → phase-scoped commit + push → update `STATUS.md`+`ROADMAP.md`. Ponytail throughout; commit only verified work; `# self-audit-ok` appended to commit commands (self-audit PreToolUse hook). cargo runs need `--manifest-path apps/desktop/src-tauri/Cargo.toml` (Bash cwd drifts).
