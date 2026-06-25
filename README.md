# Rose Glass

A **local-first, Obsidian-style PKM** that is also a **live mirror of Claude Code's activity.**
A folder of markdown becomes a navigable, queryable archive — links, backlinks, tags, full-text
search, a living force-directed knowledge graph — and the graph **lights up in real time as any
Claude Code session reads or modifies files.** It edits Markdown live, views PDFs and Word
documents in-app (editing Word as a Markdown sibling), and embeds a terminal that runs Claude
Code directly.

> **The vault is a folder of markdown. The app is a lens — and the lens glows where the work is happening.**

## Status

**Latest: v2.5.0** (tag `v2.5.0` @ `0.5.0`; signed NSIS, Verified publisher: Dylan N). The full
per-phase + per-release ledger lives in **[STATUS.md](STATUS.md)** / **[ROADMAP.md](ROADMAP.md)**;
founding decisions are in `~/.claude/second-brain/decisions/`.

- **v1.0** (tag `v1.0`): shell, vault indexer + SQLite/FTS5 + watcher, CodeMirror 6 editor, ⌘K
  search, living backdrop + glass, embedded terminal, CC activity mirror (M1 transcript-tail),
  WebGPU graph renderer, read-only MCP sidecar, neural clusters, semantic search, and the
  **lossless-only editor engines** (PDF view-only + Word view/edit-as-Markdown-sibling).
- **v2.0 – v2.3** (PRs #1–#3): drag-drop ingest · customizable graph · home-dir-scale indexing ·
  embedding durability · real CSP + **[threat model](docs/THREAT-MODEL.md)** · signed NSIS/MSI ·
  terminal clipboard + PowerShell default + attention indicator · resizable panels · solar-system
  graph physics · curated in-repo icon set · Obsidian-feel hover graph · categorized settings
  (vim / spellcheck / auto-pair / smart-lists / HTML→MD paste) · reading mode · multi-document tabs ·
  in-app Help.
- **v2.4 / v2.4.1** (PR #4 + `feat/mcp-fk-and-reembed`): the **agent interface** — Claude Code
  navigates and captures the vault through the `rose-glass-mcp` stdio sidecar (see below) — and
  (v2.4.1) on-demand **`reembed`** + free-text **`semantic_search`** over MCP
  (ADR-20260624-rose-glass-mcp-freshness-semantic).
- **v2.5.0** (`feat/reactbits-ui`): a [reactbits.dev](https://reactbits.dev) visual layer — a
  cursor-reactive **DotField** behind the graph, dock-style **magnification** on the icon rail,
  cursor-tracked **border-glow** on action buttons, a staggered **list reveal** on Notes/Tags,
  **Count Up** statusbar metrics, a per-word **Split Text** note-title reveal, and a **slide**
  open/close on the Ctrl+\` terminal — all token-driven and reduced-motion-aware (one new dep,
  `motion`).

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
opt-in `--allow-write` flag it also gains: `upsert_note` — the one write path, confined to
`inbox/*.md`, file-first so the SQLite row stays derived (A3 holds); **`reembed`** — recompute the
vault's embeddings so `related`/`semantic_search` work (no-op when already fresh); and
**`semantic_search`** — free-text semantic ranking by meaning, not keywords. The embedding model
loads **only** in `--allow-write` mode, so read-only by default is provable: without the flag the DB
opens read-only, no model is loaded, and the write/model tools are never advertised. See
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
