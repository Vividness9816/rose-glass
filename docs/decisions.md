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
| 9 | **Layout = the mockup's own force model as a seedable `stepSimulation`, NOT an `import d3-force`** (Phase 4) | §21 pins d3-force, but §2/§4 lock faithfulness to the mockup, whose cohesion+repulsion+drift+boundary sim IS the distinctive look; d3-force's force model would change it. The mockup sim already satisfies "force-directed layout"; extracted pure + seedable so the WebGPU path shares one deterministic model (ADR-20260616's "seedable Simulation when WebGPU needs shared positions"). Revisit if the user wants literal d3-force semantics. |
| 10 | **Pan/zoom/drag/click-open built on the canvas-2D path first (renderer-agnostic via a `Camera`); WebGPU renderer is opt-in behind a probe + fallback** (Phase 4) | A5's interaction is fully headless-verifiable on 2D (pure camera/hitTest tests); the GPU render needs the user's RTX 5090 eyeball (the predecessor's "verified-but-not" trap). Sharing the `Camera`/`hitTest`/`stepSimulation` means interaction works identically whichever renderer is active. |
| 11 | **Phase 9 editor engines = lossless-writes-only** (PDF view-only; docx view + edit-as-sibling-`.docx.md`; NO binary indexing) — full fork in **ADR-20260617** | A binary *writer* (pdf-lib full re-serialize / docx rebuild) silently drops the original's structure — the same class the codebase's strict-UTF-8 read already refuses. Spike confirmed mammoth is read-only. The §21 "as many formats as possible" is subordinate to the no-silent-corruption first principle. |
| 12 | **`read_file_bytes` returns a raw `tauri::ipc::Response` (ArrayBuffer), NOT the `number[]` the ADR text named** (Phase 9) | ArrayBuffer transfer avoids the JSON `number[]` byte-bloat that the PTY path's STATUS ceiling flags — an improvement, documented in-code; the binary read is confined to the PDF/docx view path. |
| 13 | **docx "Edit as Markdown" sibling = `<name>.docx.md`; re-extract opens the existing sibling, never overwrites** (Phase 9) | The `.docx.` infix keeps it distinct from a hand-authored `report.md`; an existence probe before write makes re-extraction non-destructive (the sibling is a real editable note — clobbering it would be silent data loss). |
