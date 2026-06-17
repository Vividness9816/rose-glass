# Rose Glass

A **local-first, Obsidian-style PKM** that is also a **live mirror of Claude Code's activity.**
A folder of markdown becomes a navigable, queryable archive — links, backlinks, tags, full-text
search, a living force-directed knowledge graph — and the graph **lights up in real time as any
Claude Code session reads or modifies files.** It edits Markdown live, views PDFs and Word
documents in-app (editing Word as a Markdown sibling), and embeds a terminal that runs Claude
Code directly.

> **The vault is a folder of markdown. The app is a lens — and the lens glows where the work is happening.**

## Status

Phases 0–11 are built, reviewed, and committed: shell, vault indexer + SQLite/FTS5 + watcher,
CodeMirror 6 editor, ⌘K search, living backdrop + glass, embedded terminal, CC activity mirror
(M1 transcript-tail), WebGPU graph renderer, read-only MCP sidecar, neural clusters, and the
**lossless-only editor engines** (PDF view-only + Word view/edit-as-Markdown-sibling). Remaining
to v1.0: a few live app-window eyeball checks and the **Phase 12** §20 acceptance gate. See
**[ROADMAP.md](ROADMAP.md)** for the phase plan and **[STATUS.md](STATUS.md)** for §20 acceptance
progress (each proven row cites a commit + artifact). Execution + key forks are recorded in the
ADRs under `~/.claude/second-brain/decisions/` (`-rose-glass-execution-strategy`,
`-rose-glass-phase8-activity-mechanism`, `-rose-glass-phase9-editor-engines`).

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

## Design contract

The single visual source of truth is **[docs/design-reference.html](docs/design-reference.html)** —
its `:root` tokens are copied verbatim into `apps/desktop/src/tokens/tokens.css`, and components
consume those tokens only (no raw hex). A reskin is a change to `tokens.css` alone.

## Principles (non-negotiable)

- Markdown-on-disk is the source of truth for content; the app never holds it hostage.
- SQLite holds only **derived** state — delete it and the indexer rebuilds it from the vault.
- Local-first & private by default; network is opt-in, per-feature, visible.
- It must not look AI-generated — mockup parity is an acceptance criterion.
