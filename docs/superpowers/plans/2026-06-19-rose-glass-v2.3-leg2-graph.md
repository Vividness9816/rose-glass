# Rose Glass v2.3 — Leg 2: Graph Obsidian behaviors — Implementation Plan

> **For agentic workers:** implement task-by-task with TDD where logic is pure; the renderer/interaction changes are tsc+build+eyeball-verified. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the graph behave like Obsidian: remove the All/Focus toggle, highlight a node + its 1-hop neighbors on hover (dim the rest), show labels only on hover, and render unresolved links as faded "ghost" nodes.

**Architecture:** Reuse the existing `setFocus`/`focusSet`/`nodeAlpha`/`edgeAlpha` dimming machinery — drive it from hover instead of the toggle. Ghost nodes come from a backend addition: `get_graph_payload` emits unresolved link targets (`links.dst_path IS NULL`, keyed by `dst_raw`) as `is_ghost` nodes + edges; `fromPayload` keeps them; the renderer draws them faded and non-openable.

**Tech Stack:** Rust (rusqlite) backend query; React 19 + TS + Canvas-2D renderer; Vitest + `cargo test`.

## Global Constraints

- Commands from `apps/desktop` (frontend) / `apps/desktop/src-tauri` (Rust). Gates: `pnpm exec tsc --noEmit` 0 · `pnpm exec vitest run` · `pnpm exec vite build` 0 · `cargo test --lib` · `cargo clippy --all-targets` (the pre-existing `embed.rs large_enum_variant` warning is not ours).
- Conventional commits + Co-Authored-By/Claude-Session footers; ` # self-audit-ok` appended to each `git commit` bash call. Stage files explicitly. Branch `feat/v2.3`.
- Ghost-node key = `links.dst_raw` (the raw link text). Real-node key = note path. The two never need to match a format — internal consistency (ghost node path == ghost edge dst, both from `dst_raw`) is what matters.

---

## File structure

- Modify `src-tauri/src/db/queries.rs` — `GraphNodeMeta.is_ghost` + ghost nodes/edges in `get_graph_payload` + a unit test.
- Modify `src/ipc/index.ts` — `GraphNodeMeta.is_ghost`.
- Modify `src/graph/types.ts` — `GraphNode.ghost`.
- Modify `src/graph/fromPayload.ts` — carry `ghost`; keep ghost nodes/edges.
- Modify `src/graph/fromPayload.test.ts` — ghost coverage.
- Modify `src/graph/GraphRenderer.ts` — ghost styling; labels for the hovered set only (drop always-on hub labels).
- Modify `src/graph/GraphPane.tsx` — remove Focus toggle; drive hover highlight.

---

## Task 1: Backend — ghost nodes in `get_graph_payload` (Rust, TDD)

**Files:** Modify `src-tauri/src/db/queries.rs`.

**Interfaces:**
- Produces: `GraphNodeMeta { path, title, cluster, link_count, is_ghost }`; `get_graph_payload` returns real nodes (`is_ghost=false`) + one ghost node per distinct unresolved `dst_raw` (that isn't already a real note path) with `is_ghost=true, link_count=0, cluster=None`, plus edges `src → dst_raw` for unresolved links.

- [ ] **Step 1: Add `is_ghost` to the struct**

In `GraphNodeMeta` (around line 67):
```rust
#[derive(Serialize)]
pub struct GraphNodeMeta {
    pub path: String,
    pub title: String,
    pub cluster: Option<i64>,
    pub link_count: i64,
    pub is_ghost: bool,
}
```

- [ ] **Step 2: Write the failing test** (append to the test module in `queries.rs`, mirroring the existing seed style — open an in-memory/temp conn, run the schema migration, insert notes + links)

```rust
#[test]
fn ghost_nodes_appear_for_unresolved_links() {
    let conn = test_conn(); // existing helper that applies the schema (use the same one other tests use)
    // two real notes
    upsert_note_min(&conn, "a.md", "A");
    upsert_note_min(&conn, "b.md", "B");
    // a.md -> b.md (resolved), a.md -> [[Missing]] (unresolved: dst_path NULL, dst_raw set)
    insert_link(&conn, "a.md", Some("b.md"), "b.md");
    insert_link(&conn, "a.md", None, "Missing");

    let p = get_graph_payload(&conn).unwrap();
    // real notes are not ghosts
    assert!(p.nodes.iter().any(|n| n.path == "a.md" && !n.is_ghost));
    // one ghost node for the unresolved target
    let ghost = p.nodes.iter().find(|n| n.path == "Missing").expect("ghost node");
    assert!(ghost.is_ghost && ghost.link_count == 0);
    // an edge points to the ghost
    assert!(p.edges.iter().any(|e| e.src == "a.md" && e.dst == "Missing"));
    // the resolved edge still exists
    assert!(p.edges.iter().any(|e| e.src == "a.md" && e.dst == "b.md"));
}
```
(If `test_conn`/`upsert_note_min`/`insert_link` helpers don't exist, write minimal inline equivalents using the real schema migration + `upsert_note`/`replace_links` already in this file. Check the existing tests in `db/` for the established seed pattern and reuse it.)

- [ ] **Step 3: Run — expect fail** (`is_ghost` missing / no ghost rows)

Run: `cd src-tauri && cargo test --lib ghost_nodes_appear_for_unresolved_links`
Expected: FAIL (struct field or assertion).

- [ ] **Step 4: Implement** — set `is_ghost: false` on the real-node mapping, then append ghost nodes + ghost edges in `get_graph_payload`:

```rust
// real nodes (existing query) — add is_ghost: false to the GraphNodeMeta { ... }

// ghost nodes: one per distinct unresolved target that isn't already a real note
let mut gstmt = conn.prepare(
    "SELECT DISTINCT l.dst_raw
     FROM links l
     WHERE l.dst_path IS NULL AND l.dst_raw IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.path = l.dst_raw)",
)?;
let ghosts = gstmt.query_map([], |r| {
    let raw: String = r.get(0)?;
    Ok(GraphNodeMeta { path: raw.clone(), title: raw, cluster: None, link_count: 0, is_ghost: true })
})?;
for g in ghosts { nodes.push(g?); }

// unresolved edges: src -> dst_raw (append to the existing resolved-edge vec)
let mut gestmt = conn.prepare(
    "SELECT DISTINCT src_path, dst_raw FROM links WHERE dst_path IS NULL AND dst_raw IS NOT NULL",
)?;
let gedges = gestmt.query_map([], |r| {
    Ok(GraphEdgeMeta { src: r.get(0)?, dst: r.get(1)? })
})?;
for e in gedges { edges.push(e?); }
```
(Make `nodes`/`edges` `let mut` if they aren't already; they're built then returned.)

- [ ] **Step 5: Run — expect pass**

Run: `cargo test --lib ghost_nodes_appear_for_unresolved_links` → PASS. Then `cargo test --lib` (full) + `cargo clippy --all-targets` (only the pre-existing `embed.rs` warning).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/db/queries.rs
git commit -m "feat(v2.3): emit unresolved links as ghost nodes in the graph payload  # self-audit-ok"
```

---

## Task 2: Frontend types + fromPayload (TDD)

**Files:** Modify `src/ipc/index.ts`, `src/graph/types.ts`, `src/graph/fromPayload.ts`, `src/graph/fromPayload.test.ts`.

**Interfaces:**
- Consumes: `GraphNodeMeta.is_ghost` (Task 1).
- Produces: `GraphNode.ghost: boolean`; `payloadToGraphData` carries it; ghost nodes get `links:0, hub:false`; edges to ghosts are kept (ghost paths are in `idOf`).

- [ ] **Step 1: Add `is_ghost` to the ipc type** — in `src/ipc/index.ts` `GraphNodeMeta`:
```ts
export interface GraphNodeMeta {
  path: string;
  title: string;
  cluster: number | null;
  link_count: number;
  is_ghost: boolean;
}
```

- [ ] **Step 2: Add `ghost` to `GraphNode`** — in `src/graph/types.ts`, add `ghost: boolean;` to the interface (document: "true = unresolved-link placeholder; faded + non-openable").

- [ ] **Step 3: Write the failing test** — append to `src/graph/fromPayload.test.ts`:
```ts
it('carries ghost nodes and keeps edges pointing at them', () => {
  const p = {
    nodes: [
      { path: 'a.md', title: 'A', cluster: null, link_count: 1, is_ghost: false },
      { path: 'Missing', title: 'Missing', cluster: null, link_count: 0, is_ghost: true },
    ],
    edges: [{ src: 'a.md', dst: 'Missing' }],
  };
  const gd = payloadToGraphData(p);
  const ghost = gd.nodes.find((n) => n.path === 'Missing')!;
  expect(ghost.ghost).toBe(true);
  expect(ghost.hub).toBe(false);
  expect(gd.edges.length).toBe(1); // edge to the ghost survives
});
```

- [ ] **Step 4: Run — expect fail** (`pnpm exec vitest run src/graph/fromPayload.test.ts`).

- [ ] **Step 5: Implement** — in `payloadToGraphData`, set `ghost: n.is_ghost` on each node and force `links:0, hub:false` when ghost (so a ghost never renders as a hub):
```ts
return {
  // ...existing fields...
  links: n.is_ghost ? 0 : n.link_count,
  r: n.is_ghost ? 4 : 4 + 7 * (n.link_count / maxLinks),
  hub: !n.is_ghost && n.link_count >= maxLinks * 0.66,
  ghost: n.is_ghost,
};
```
(The edge filter `idOf.has(e.src) && idOf.has(e.dst)` already keeps ghost edges because ghost paths are now in `idOf`.)

- [ ] **Step 6: Run — expect pass**; then `pnpm exec tsc --noEmit`.

- [ ] **Step 7: Commit**
```bash
git add apps/desktop/src/ipc/index.ts apps/desktop/src/graph/types.ts apps/desktop/src/graph/fromPayload.ts apps/desktop/src/graph/fromPayload.test.ts
git commit -m "feat(v2.3): carry ghost nodes through payload->GraphData  # self-audit-ok"
```

---

## Task 3: Renderer — ghost styling + hover labels (eyeball)

**Files:** Modify `src/graph/GraphRenderer.ts`.

> Rendering: verified by tsc + build + eyeball. The node-lookup logic stays covered by `GraphRenderer.test.ts`.

- [ ] **Step 1: Ghost nodes render faded** — in `draw()`'s node loop, branch FIRST on `n.ghost`: draw a small outline-only disc at reduced alpha (no aura/ring/orbit/glow), using the muted label/text color rather than a cluster color:
```ts
if (n.ghost) {
  ctx.globalAlpha = this.nodeAlpha(n.id) * 0.5;
  ctx.beginPath();
  ctx.arc(n.x, n.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = rgba(theme.label, 0.25);
  ctx.fill();
  ctx.strokeStyle = rgba(theme.label, 0.35);
  ctx.lineWidth = 0.6;
  ctx.stroke();
  return; // skip the ornate hub/leaf rendering
}
```
(Place this as the first statement inside `nodes.forEach((n) => { ... })`, after setting `ctx.globalAlpha`.)

- [ ] **Step 2: Drop always-on hub labels** — remove the `ctx.fillText(n.name, ...)` block in the hub branch (the two `ctx.font`/`fillText`/`textAlign` lines).

- [ ] **Step 3: Labels for the hovered set only** — after the node loop (before the activity-flare overlay), if `this.focusSet` is set, draw a label under each focus-set node:
```ts
if (this.focusSet) {
  ctx.font = 'bold 10px Inter, sans-serif';
  ctx.fillStyle = rgba(theme.label, 0.9);
  ctx.textAlign = 'center';
  for (const id of this.focusSet) {
    const n = this.byId.get(id);
    if (n) ctx.fillText(n.name, n.x, n.y + n.r + 14);
  }
  ctx.textAlign = 'left';
}
```

- [ ] **Step 4: Verify** — `pnpm exec tsc --noEmit && pnpm exec vite build` (0).

- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src/graph/GraphRenderer.ts
git commit -m "feat(v2.3): faded ghost nodes + labels only for the hovered set  # self-audit-ok"
```

---

## Task 4: GraphPane — remove Focus toggle, drive hover (eyeball)

**Files:** Modify `src/graph/GraphPane.tsx`.

- [ ] **Step 1: Remove the Focus scope** — delete the `scope` state + `scopeRef`, the `<button>All` and `<button>Focus` in `.graph-controls`, and the `useEffect` that calls `setFocus(scope === 'focus' ? ...)`. Keep `activePath` in props (still passed by Shell) but it no longer drives focus. In `build()`, replace the `r.setFocus(scopeRef.current === 'focus' ? ... : null)` line with `r.setFocus(null)` (start un-dimmed).

- [ ] **Step 2: Drive hover from `onMove`** — in the pan/zoom/drag effect's `onMove`, in the `drag.mode === 'none'` branch (which already picks a node for the cursor), also set the hover focus:
```ts
if (drag.mode === 'none') {
  const hit = r.pickAtScreen(sx, sy);
  canvas.style.cursor = hit ? 'pointer' : 'default';
  r.setFocus(hit ? hit.path : null); // hover → highlight node + neighbors, dim rest
  return;
}
```

- [ ] **Step 2b: Clear on leave** — add a `pointerleave` listener that clears: `const onLeave = () => rendererRef.current?.setFocus(null);` registered/removed alongside the others (`canvas.addEventListener('pointerleave', onLeave)`).

- [ ] **Step 3: Don't open ghost nodes** — in `onUp`'s click-to-open branch, guard: `if (n && !n.ghost) onOpenNodeRef.current?.(n.path);` so clicking a ghost is a no-op.

- [ ] **Step 4: Verify** — `pnpm exec tsc --noEmit && pnpm exec vite build` (0).

- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src/graph/GraphPane.tsx
git commit -m "feat(v2.3): hover-highlight graph + remove the All/Focus toggle  # self-audit-ok"
```

---

## Task 5: Leg gates + eyeball + push

- [ ] **Step 1: Gates** — `cd apps/desktop && pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm exec vite build` (all green) and `cd src-tauri && cargo test --lib && cargo clippy --all-targets` (only the pre-existing `embed.rs` warning).
- [ ] **Step 2: Eyeball (`pnpm tauri dev`, vault open):**
  - The All/Focus buttons are gone from the graph header.
  - Hovering a node highlights it + its direct neighbors and dims the rest; moving off clears it.
  - A label appears only under the hovered node (+ neighbors); no labels otherwise.
  - Unresolved `[[links]]` show as small faded ghost dots; clicking one does nothing; clicking a real node still opens it.
- [ ] **Step 3: Push** — `git push origin feat/v2.3`.

## Self-Review

**Spec coverage:** remove Focus toggle (T4) ✓ · hover highlight + dim (T3/T4) ✓ · labels-on-hover (T3) ✓ · ghost nodes backend+frontend (T1/T2) + faded styling + non-openable (T3/T4) ✓. GPU label-on-hover + ghost parity remain the documented follow-up (2D is default) — not in this leg.
**Placeholder scan:** none — every step has concrete code; the Rust test-helper names are flagged "reuse the existing seed pattern" with a fallback.
**Type consistency:** `is_ghost` (Rust `GraphNodeMeta` + ipc `GraphNodeMeta`) ↔ `GraphNode.ghost` (frontend) are mapped in `fromPayload`; `setFocus(path|null)` signature unchanged (reused for hover); `n.ghost` guard used identically in renderer + click handler.
