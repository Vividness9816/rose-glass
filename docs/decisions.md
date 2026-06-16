# Autonomous-run decision log (spec §3)

Where the spec is silent, the agent picks the option most consistent with §2 and
records it here. The execution-strategy fork is in
`~/.claude/second-brain/decisions/ADR-20260616-rose-glass-execution-strategy.md`.

| # | Decision | Rationale |
|---|---|---|
| 1 | **Workspace skeleton from init** (`apps/desktop` only; no empty `packages/shared`) | Honors locked §7 layout, zero later migration, no empty-package smell. |
| 2 | **Window identifier `lab.home.roseglass`**, productName "Rose Glass", crate stays `desktop`/`desktop_lib` | Renaming the Rust crate touches main/lib refs for no user-visible gain. |
| 3 | **Frameless window** (`decorations:false`) + custom titlebar + drag region | Matches the mockup's traffic-light titlebar. ponytail ceiling: native edge-resize is reduced on Windows for frameless; upgrade path = add resize handles / `tauri-plugin-decorum` if it bites. |
| 4 | **Self-hosted fonts via `@fontsource/inter` + `@fontsource/jetbrains-mono`** | Drops the mockup's Google-Fonts `@import` → honors §2.1 local-first. |
| 5 | **Light theme = untuned first pass**, toggle mechanism real | Mockup has zero light tokens; final light values are net-new design work (Taste increment, Phase 6). Mechanism (data-theme + persistence + override block) is final. |
| 6 | **Graph colors resolved from tokens via a hidden-probe `resolveGraphTheme()`** | `getComputedStyle` doesn't substitute `var()` chains for custom props; the probe resolves them. Keeps the cluster→hue map in `tokens.css` (§11.1), not JS. |
| 7 | **Graph physics un-seeded this increment** | Motion is decorative, not a correctness surface. Seedable extraction lands when the WebGPU renderer needs deterministic shared positions (Phase 4). |
| 8 | **No graphology / Renderer-interface / VaultStore yet** | Each gets introduced with its real second caller (real indexer / WebGPU), not speculatively. |
