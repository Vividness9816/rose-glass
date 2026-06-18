# Rose Glass — operative build spec

The durable contract a builder must not violate. Phases → [ROADMAP.md](../ROADMAP.md).
Acceptance → [STATUS.md](../STATUS.md). Execution strategy + rationale →
`~/.claude/second-brain/decisions/ADR-20260616-rose-glass-execution-strategy.md`.
Run-time decisions → [decisions.md](decisions.md). Visual contract →
[design-reference.html](design-reference.html).

## First principles (non-negotiable)
1. Local-first & private by default. Offline; no telemetry/account. Network opt-in, per-feature, visible.
2. Markdown-on-disk is the source of truth for content. No proprietary content store.
3. SQLite holds only **derived** state — delete it, the indexer rebuilds it from the vault (search, links, tags, clusters, embeddings are all caches).
4. Design-system-first, faithful to the mockup. Tokens before components; one themed token layer.
5. It must not look AI-generated — an acceptance criterion (mockup parity + Impeccable + Taste + diffs).
6. Agent-legible & agent-reflective (MCP read surface + the CC activity mirror).
7. No legacy debt — rollback is git.
8. Deterministic & incremental indexing (content-hash driven).

## Locked decisions (spec §21)
- **Name:** Rose Glass — reuses the VaultForge design language; no content carried over.
- **Stack (pinned):** Tauri 2 · React 19 + TS strict · pnpm workspace · Vite · graphology (model) · **WebGPU primary + canvas-2D fallback** · d3-force · SQLite owned in Rust (rusqlite) + FTS5 · ~~sqlite-vec (embeddings)~~ [superseded → brute-force cosine KNN over the stored BLOBs, ADR-20260618; sqlite-vec is the named upgrade past ~100k notes] · CodeMirror 6 (text/code) · MuPDF WASM + PDF.js (true PDF edit) · TipTap/ProseMirror + docx bridge · dashersw/liquid-glass-js (glass components) · backdrop-filter + SVG feTurbulence/feDisplacement (large live-gradient surfaces) · @shadergradient/react (backdrop) · xterm.js + portable-pty · self-hosted Inter + JetBrains Mono.
- **Execution:** autonomous across sessions, automated gates replace human approval; each increment honestly verifiable before claimed done.
- **Editor:** true native in-app editing, as many formats as possible.
- **Activity:** all CC sessions (global hooks + transcript tail); ephemeral; external-to-vault shown muted in the pane only. **Hook-install + transcript-tail are safety-gated (ADR).**
- **Graph:** SQLite-derived; WebGPU primary at fixed 4K; gravity + collision + free clusters around a fixed center; full mouse interaction; RTX 5090.
- **Storage invariant:** SQLite is canonical *derived* store; every index is rebuildable — delete the DB, rebuild from the vault.

## Engineering conventions (spec §16)
- TypeScript strict, no `any`. No hardcoded colors — components read tokens only (`tokens.css` is the sole exception). No legacy/dual code paths. Derived-state guard: any new table states how it rebuilds from the vault. Theme/ids centralized in one constant. Don't export non-components from component modules (breaks Fast Refresh). TDD where it pays; `tsc --noEmit` is a hard gate.

## Out of scope, v1 (spec §18)
Sync/multi-device · mobile · plugin marketplace (a host may exist; distribution does not) · write-heavy MCP tools · arbitrary reflow of flattened/scanned PDF text.

## Anti-patterns to avoid (spec §19 — the VaultForge distillation)
1. Batch component repoints for a reskin → token-redefine. 2. Keeping a legacy theme "for rollback" → git is rollback. 3. html2canvas glass over the live gradient → backdrop-filter + SVG displacement. 4. Exporting non-components from component files. 5. Theme ids as string literals across tests → one constant. 6. Treating the index as primary data. 7. Dark-only generative/graph layers → theme-aware. 8. Random/string-hash graph coloring → color from `clusters`, themed via the palette. 9. Persisting activity events as history → ephemeral. 10. Letting Impeccable's defaults overrule the validated mockup → brand whitelisted.

## Windows dev gotchas (spec §17)
- Zombie Vite on port 1420 after dep install / restart — kill the owning PID + the app exe before relaunch.
- Fast-Refresh full reloads when a component module exports a non-component — avoid by construction.
- WebGPU primary, 2D fallback — guard init so a driver hiccup falls back, not blanks the graph.
