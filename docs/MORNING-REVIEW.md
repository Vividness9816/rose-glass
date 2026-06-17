# Morning review — overnight run 2026-06-17

Autonomous run on `master` (private `Vividness9816/rose-glass`). Order per your
direction: **Phase 8 → 4 → 9**. Everything below is committed + pushed; the working
tree is clean and `origin/master` is in sync.

## Gates (all green right now — re-run from `C:\Users\dnoye\rose-glass`)
```
pnpm --filter @rose-glass/desktop exec tsc --noEmit                              # 0
pnpm --filter @rose-glass/desktop test                                           # vitest 50/50
pnpm --filter @rose-glass/desktop build                                          # 0
cargo test  --manifest-path apps/desktop/src-tauri/Cargo.toml                    # 52/52 (+3 #[ignore]d)
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings   # 0
```

## What shipped (newest first)
| Commit | What |
|---|---|
| `ef26a72` | **Phase 9 foundation** — editorKind router + `.md/.txt/.pdf` file associations |
| `5ff7011` | **Phase 4b** — WebGPU graph renderer behind probe + airtight 2D fallback (3-lens reviewed) |
| `926e4c4` | **Phase 4a** — pan/zoom/drag/click-open + seedable simulation (tested) |
| `b1088a7` | **Phase 8 (M1)** — CC activity mirror via transcript-tail (3-lens reviewed) |
| ADR | `~/.claude/second-brain/decisions/ADR-20260617` — Phase-8 mechanism + the settings.json autonomy boundary |

Each phase: spike → build → **3-lens adversarial review (every confirmed finding fixed + regression test)** → commit. Phase 8 review = 7/7 fixed; Phase 4 review = 10/10 fixed (incl. a HIGH fallback-blank bug).

## ✅ Verification that NEEDS YOUR EYES (the reserved-for-morning parts)

These are BUILT + self-verified (tests/compile/gates) but their *live* behavior is
deliberately left for you — I did **not** claim them "proven" (the predecessor's
`device.ts` "verified-but-not" trap). Run the app first:
```
cd C:\Users\dnoye\rose-glass\apps\desktop
pnpm tauri dev      # NOT from C:\Users\dnoye (pnpm junction-dupes → :1420 collisions)
```

1. **Phase 4 — WebGPU graph (RTX 5090).** In the graph header click the **GPU** toggle
   (it's disabled until the WebGPU probe succeeds). Confirm: the graph renders on the
   GPU at your 4K, and **wheel-zoom / drag-pan / drag-node / click-a-node-opens-it** all
   feel right. Toggle back to **2D** — it must keep working (the canvas remounts; this
   was the HIGH review finding). If the GPU render looks wrong, the app still works
   (it falls back to canvas-2D — a GPU failure can never blank the graph). GPU edges
   are intentionally leaner than the 2D path (no auras/particles/curves) — tell me if
   you want full visual parity and I'll grow the shaders.

2. **Phase 8 — Activity mirror (use a SANITIZED / throwaway vault).** Open the **◎
   Activity** item in the left rail. With another Claude Code session running, confirm:
   in-vault file reads pulse a node **violet**, edits flare it **rose**; the pane lists
   activity; external-session rows show **muted with no file path**; the health row shows
   liveness / tallies. ⚠ Use a vault with no secret paths — the proof of redaction is
   that external paths never render, but eyeball it on a throwaway vault to be safe.

3. **Phase 6 — visual taste (A11/A2).** Eyeball the living backdrop + glass + light
   theme. Dials if you want to tune: `ShaderBackdrop.tsx` backdrop opacity (0.8),
   `GraphRenderer.ts` `GRAPH_BG_ALPHA` (0.4).

## 🔒 Reserved-for-you, NOT touched autonomously
- **`~/.claude/settings.json` was NOT modified.** Per ADR-20260617, Phase 8 ships as
  **M1 transcript-tail only** (read-only). The **M2 global hook** is **plan-only**:
  `installer.rs` computes + validates + uninstalls the hook merge with **no `fs::write`
  in existence**, and it's proven against your live settings.json read-only (20 hooks
  preserved + round-trips: `cargo test ... installer -- --ignored`). To ARM the live
  hook later is a deliberate, attended step we do together — say the word and I'll wire
  the write path (atomic backup + re-validate-all + uninstall) and we run it with you watching.

## 🚧 Not done (honest remainder to v1.0)
- **Phase 9 engines** — the editorKind router + file associations are in, but the
  actual **PDF.js/MuPDF (PDF view→edit)** and **TipTap + docx bridge** engines are a
  focused increment that needs you at the app window to verify the live editors (+ a
  binary-read IPC + indexing non-md files). Spike confirmed `pdfjs-dist` + `mammoth`
  install cleanly. Today, opening a pdf/docx shows an honest "editing coming" placeholder.
- **Phase 12** — the full §20 v1.0 acceptance gate, runnable once the eyeballs above
  pass and the Phase 9 engines land.
- **A1** — a formal `/ponytail-audit`; **A2** — an automated screenshot-diff harness.

## Where state lives (for resuming)
`STATUS.md` (§20 ledger, per-row commit + artifact) · `ROADMAP.md` (phase status) ·
`docs/decisions.md` (run decisions #9/#10) · the ADRs in `~/.claude/second-brain/decisions/`.
9 of 12 phases' worth is built; the remainder is the Phase-9 engines + Phase-12 gate + your eyeballs.
