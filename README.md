# Rose Glass

A **local-first, Obsidian-style PKM** that is also a **live mirror of Claude Code's activity.**
A folder of markdown becomes a navigable, queryable archive — links, backlinks, tags, full-text
search, a living force-directed knowledge graph — and the graph **lights up in real time as any
Claude Code session reads or modifies files.** It edits documents in-app across many formats and
embeds a terminal that runs Claude Code directly.

> **The vault is a folder of markdown. The app is a lens — and the lens glows where the work is happening.**

## Status

Foundation increment (Phase 0/1 + the canvas-2D graph leg) is built. See **[ROADMAP.md](ROADMAP.md)**
for the full phase plan and **[STATUS.md](STATUS.md)** for §20 acceptance progress (proven / stubbed
/ untouched, each proven row citing a commit + artifact). Execution strategy is recorded in
`~/.claude/second-brain/decisions/ADR-20260616-rose-glass-execution-strategy.md`.

## Stack

- **Shell:** Tauri 2 (Rust) + WebView2
- **Frontend:** React 19 + TypeScript (strict) + Vite
- **Monorepo:** pnpm workspace (`apps/desktop`)
- **Graph:** canvas-2D now (token-driven); WebGPU primary + d3-force later
- **Store (later):** SQLite owned in Rust (derived, rebuildable from the vault)
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
