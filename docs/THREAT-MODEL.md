# Rose Glass — Threat Model

**Scope:** a single-user, local-first desktop PKM (Tauri 2 + React). The trust boundary is
the local user's machine; there is no multi-tenant server and no remote attacker surface beyond
content the user themselves pulls into the vault. Last reviewed 2026-06-18 (v2.0).

## Assets
- The vault's note content + the derived `.rose-glass/index.db` (links, FTS, embeddings).
- The Claude Code activity stream (which files the user's CC sessions touch).

## Intentional, by-design powers (NOT bugs)

### The embedded terminal is a full RCE surface — on purpose
The terminal drawer (Phase 7) spawns a **real shell** (`COMSPEC`/`SHELL`) via `portable-pty`
to run Claude Code. That is **arbitrary code execution by design** — it is the feature. The
frontend may also pass an **arbitrary `cwd`** to the PTY (`terminal.rs` `resolve_cwd` →
`cmd.cwd()`, unvalidated). Both are acceptable because the user already has a shell on their own
machine; the app grants no capability they lack.

**Consequence for the rest of the design:** the **CSP is the load-bearing control** standing
between a poisoned note's rendered HTML (an XSS) and an IPC call to `pty_spawn`. Therefore:
- `script-src` must **never** gain `'unsafe-inline'` or `'unsafe-eval'` (see CSP section).
- If `pty_spawn`'s arbitrary-cwd power is ever exposed beyond the trusted local user, constrain
  `cwd` to the vault or an allowlist. *(Recommended defense-in-depth; not blocking today —
  flagged in ADR-20260618-rose-glass-v2-architecture.)*

## Hardening controls

### Content-Security-Policy (defense-in-depth)
`tauri.conf.json` sets a real CSP (was `null` through v1.0). Current baseline:

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
worker-src 'self' blob:;
connect-src 'self' ipc: http://ipc.localhost
```

Rationale per directive: `script-src 'self' 'wasm-unsafe-eval'` allows the bundled app + PDF.js
WASM decoders but **no inline/eval** (the RCE wall above); `worker-src blob:` for the PDF.js
worker; `img-src data: blob:` for mammoth-rendered docx images + canvas; `style-src
'unsafe-inline'` for runtime CSS-var theming (styles can't execute code); `connect-src ipc:
http://ipc.localhost` for Tauri v2 IPC on Windows. DOMPurify still sanitizes docx-derived HTML
— the CSP is the *second* wall, not the first.

> **VERIFY (flagged):** this CSP is set but render paths must be confirmed in a real build —
> PDF view, the WebGPU graph, the terminal, docx view. Tighten down (never up) if all render;
> the most likely needed additions are already in the baseline. See the v2.0 spec's
> "Items needing user verification."

### Activity scope — structural redaction + lexical fail-closed
`activity.rs` classifies each CC-reported file path as `Vault{rel}` or `External`. The
`External` variant **structurally carries no path field**, so an out-of-vault path can never
cross the IPC boundary into the UI. Classification is purely lexical and **fails closed**: a
`..`-escape returns `External`. The vault root is **canonicalized once at open-time**
(`canonical_root`) so case / 8.3 short-names / a symlinked root compare correctly.

- **Residual (LOW, display-only):** a symlink *inside* the vault pointing out is not
  FS-resolved per-event (that would cost a syscall per line and break delete-event
  classification). Worst case is a mislabeled path in the activity pane — not exfiltration;
  every real file operation goes through `fs_safe`, which *does* resolve symlinks and confines
  to the vault.

### File operations — `fs_safe`
All real file reads/writes (editor open/save, drag-drop ingest copy) go through `fs_safe`,
which canonicalizes and confines paths to the vault, resolving symlinks before touching disk.

### Indexer skip floor
One shared `should_skip` (hardcoded dirs + dot-prefix) gates all three index write paths, so the
home dir can be a vault without indexing `node_modules`/`.git`/caches, and live edits can't
create graph nodes a rebuild would drop (A3 invariant).

## Out of scope
Network attackers (no inbound surface), multi-user isolation (single-user app), and protecting
the user from their own shell (the terminal is intentional RCE).
