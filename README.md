# Rose Glass

A **local-first, Obsidian-style PKM** that is also a **live mirror of Claude Code's activity.**
A folder of markdown becomes a navigable, queryable archive — links, backlinks, tags, full-text
search, a living force-directed knowledge graph — and the graph **lights up in real time as any
Claude Code session reads or modifies files.** It edits Markdown live, views PDFs and Word
documents in-app (editing Word as a Markdown sibling), and embeds a terminal that runs Claude
Code directly.

> **The vault is a folder of markdown. The app is a lens — and the lens glows where the work is happening.**

## Status

**v1.0 shipped** (tag `v1.0`): shell, vault indexer + SQLite/FTS5 + watcher, CodeMirror 6 editor,
⌘K search, living backdrop + glass, embedded terminal, CC activity mirror (M1 transcript-tail),
WebGPU graph renderer, read-only MCP sidecar, neural clusters, semantic search, and the
**lossless-only editor engines** (PDF view-only + Word view/edit-as-Markdown-sibling).

**v2.0** (branch `feat/v2.0`) adds:

- **Drag-and-drop ingest** — drop a file on the window; it's copied into `inbox/` (if outside the
  vault), indexed (md/txt become graph nodes), and opened in the right pane.
- **Customizable graph** — an expandable panel (top-right of the graph) tunes gravity, node
  strength, movement, liveliness, per-cluster colors, and free-float vs fixed mode; persisted.
- **Home-dir-scale indexing** — the `ignore` crate + a shared skip floor across every index path,
  so opening `~` indexes the real notes, not `node_modules`/build junk.
- **Embedding durability** — the model is cached in app state; a failed fetch is remembered with a
  **Retry** affordance (no silent re-download); search latency is surfaced; a model swap purges
  stale vectors.
- **Hardening** — a real CSP, a canonicalized vault root for activity scope, a bounded/coalesced
  watcher, a pre-attach terminal ring buffer (no lost first prompt), and a documented
  **[threat model](docs/THREAT-MODEL.md)** (the terminal is intentional RCE by design).
- **Signed installer** — `tauri build` emits a code-signed NSIS/MSI (Verified publisher: Dylan N).

See **[ROADMAP.md](ROADMAP.md)** / **[STATUS.md](STATUS.md)** for phase + acceptance detail, the
v2.0 design under **[docs/superpowers/specs](docs/superpowers/specs/)**, and the founding decisions
in `~/.claude/second-brain/decisions/` (notably `ADR-20260618-rose-glass-v2-architecture`).

## Stack

- **Shell:** Tauri 2 (Rust) + WebView2
- **Frontend:** React 19 + TypeScript (strict) + Vite
- **Monorepo:** pnpm workspace (`apps/desktop`)
- **Graph:** canvas-2D + WebGPU renderer (token-driven; the mockup's seedable force model)
- **Store:** SQLite owned in Rust (FTS5 + derived clusters/embeddings; rebuildable from the vault)
- **Editor:** CodeMirror 6 (Markdown/text); PDF.js (PDF view-only); mammoth (Word view → Markdown sibling)
- **Fonts:** self-hosted Inter + JetBrains Mono

## Develop

```bash
pnpm install
pnpm dev          # tauri dev (WebView2 + Vite HMR)
pnpm tsc          # type-check gate (tsc --noEmit)
pnpm test         # vitest
pnpm build        # tsc && vite build
```

## Agent interface (MCP)

Rose Glass ships a stdio MCP sidecar (`rose-glass-mcp`) so Claude Code can navigate and capture
into the vault through tools instead of ripgrep + file reads — it works even when the app is closed
(the client spawns it). Read tools: `search`, `get_note`, `manifest` (whole-vault triage),
`related` (model-free semantic neighbours), `get_semantic_clusters`, `maintenance_report`. Under an
opt-in `--allow-write` flag it also gains `upsert_note` — the one write path, confined to
`inbox/*.md`, file-first so the SQLite row stays derived (A3 holds). Read-only by default is
provable: without the flag the DB opens read-only and the write tool is never advertised. See
**[docs/agent-interface.md](docs/agent-interface.md)** for the tool list, the `--check` doctor, and
a copy-pasteable `.mcp.json`.

## Design contract

The single visual source of truth is **[docs/design-reference.html](docs/design-reference.html)** —
its `:root` tokens are copied verbatim into `apps/desktop/src/tokens/tokens.css`, and components
consume those tokens only (no raw hex). A reskin is a change to `tokens.css` alone.

## Principles (non-negotiable)

- Markdown-on-disk is the source of truth for content; the app never holds it hostage.
- SQLite holds only **derived** state — delete it and the indexer rebuilds it from the vault.
- Local-first & private by default; network is opt-in, per-feature, visible.
- It must not look AI-generated — mockup parity is an acceptance criterion.
