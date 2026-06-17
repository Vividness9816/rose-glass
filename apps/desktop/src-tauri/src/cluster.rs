//! Deterministic k-means over embedding vectors → a cluster_id per item (§11). Pure (no
//! model), so it's reproducible + unit-testable. Deterministic init (the first k distinct
//! points) + Lloyd iteration → stable cluster ids. k is capped to the item count, and to
//! ≤4 by the caller so ids land in the graph's 4-colour cluster palette.

/// Assign each vector to one of k clusters; returns the cluster_id (0..k) per input vector
/// in input order. Empty input → empty output. k is capped to the number of items.
pub fn kmeans(vectors: &[Vec<f32>], k: usize, max_iters: usize) -> Vec<usize> {
    let n = vectors.len();
    if n == 0 || k == 0 {
        return vec![0; n];
    }
    let k = k.min(n);
    let dim = vectors[0].len();

    // Deterministic init: the first k distinct points (pad with wrap-around if too few distinct).
    let mut centroids: Vec<Vec<f32>> = Vec::with_capacity(k);
    for v in vectors {
        if centroids.len() == k {
            break;
        }
        if !centroids.iter().any(|c| c == v) {
            centroids.push(v.clone());
        }
    }
    while centroids.len() < k {
        centroids.push(vectors[centroids.len() % n].clone());
    }

    let mut assign = vec![0usize; n];
    for _ in 0..max_iters {
        // assign step
        let mut changed = false;
        for (i, v) in vectors.iter().enumerate() {
            let mut best = 0usize;
            let mut best_d = f32::INFINITY;
            for (c, ctr) in centroids.iter().enumerate() {
                let d = sq_dist(v, ctr);
                if d < best_d {
                    best_d = d;
                    best = c;
                }
            }
            if assign[i] != best {
                assign[i] = best;
                changed = true;
            }
        }
        if !changed {
            break;
        }
        // update step (empty clusters keep their old centroid)
        let mut sums = vec![vec![0.0f32; dim]; k];
        let mut counts = vec![0usize; k];
        for (i, v) in vectors.iter().enumerate() {
            let c = assign[i];
            counts[c] += 1;
            for (d, x) in v.iter().enumerate() {
                sums[c][d] += x;
            }
        }
        for c in 0..k {
            if counts[c] > 0 {
                for d in 0..dim {
                    centroids[c][d] = sums[c][d] / counts[c] as f32;
                }
            }
        }
    }
    assign
}

fn sq_dist(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| {
            let d = x - y;
            d * d
        })
        .sum()
}

/// k-means cluster count = the graph's 4-colour palette (capped to item count by kmeans()).
pub const K: usize = 4;

/// All notes' (path, text-to-embed) in path order — text is title + body from the FTS row.
pub fn read_texts(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt =
        conn.prepare("SELECT path, title || ' ' || body FROM notes_fts ORDER BY path")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    rows.collect()
}

/// Persist embeddings + their k-means clusters for `items` (path, vector), clearing both
/// derived tables first, in one transaction. Returns the number of distinct clusters.
/// The model param is the embedding-model id recorded per row. Pure of any model — takes
/// pre-computed vectors, so it's unit-testable without ONNX.
pub fn store_clusters(
    conn: &mut rusqlite::Connection,
    items: &[(String, Vec<f32>)],
    k: usize,
    model: &str,
    now: i64,
) -> rusqlite::Result<usize> {
    let vectors: Vec<Vec<f32>> = items.iter().map(|(_, v)| v.clone()).collect();
    let assign = kmeans(&vectors, k, 50);

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM clusters", [])?;
    tx.execute("DELETE FROM embeddings", [])?;
    {
        // SELECT … WHERE EXISTS so a note deleted concurrently during the (lock-free) embed
        // is skipped, not an FK violation that rolls back the whole run. (OR IGNORE would
        // not help — it doesn't suppress FK errors.)
        let mut emb = tx.prepare(
            "INSERT INTO embeddings (path, vector, model)
             SELECT ?1,?2,?3 WHERE EXISTS (SELECT 1 FROM notes WHERE path=?1)",
        )?;
        let mut cl = tx.prepare(
            "INSERT INTO clusters (path, cluster_id, computed_at)
             SELECT ?1,?2,?3 WHERE EXISTS (SELECT 1 FROM notes WHERE path=?1)",
        )?;
        for (i, (path, v)) in items.iter().enumerate() {
            emb.execute(rusqlite::params![path, crate::embed::vec_to_blob(v), model])?;
            cl.execute(rusqlite::params![path, assign[i] as i64, now])?;
        }
    }
    tx.commit()?;
    Ok(assign.iter().copied().collect::<std::collections::HashSet<_>>().len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_obvious_clusters_group_correctly() {
        let vs = vec![
            vec![0.0, 0.0],
            vec![0.1, 0.0],
            vec![0.0, 0.1], // tight group near origin
            vec![10.0, 10.0],
            vec![10.1, 10.0],
            vec![10.0, 10.1], // tight group far away
        ];
        let a = kmeans(&vs, 2, 50);
        assert_eq!(a[0], a[1]);
        assert_eq!(a[1], a[2]);
        assert_eq!(a[3], a[4]);
        assert_eq!(a[4], a[5]);
        assert_ne!(a[0], a[3]); // the two groups are different clusters
    }

    #[test]
    fn empty_input_and_k_is_capped() {
        assert!(kmeans(&[], 4, 10).is_empty());
        let one = vec![vec![1.0, 2.0]];
        assert_eq!(kmeans(&one, 4, 10), vec![0]); // k capped to n=1
    }

    #[test]
    fn is_deterministic() {
        let vs = vec![vec![1.0, 1.0], vec![1.1, 0.9], vec![9.0, 9.0], vec![8.8, 9.2]];
        assert_eq!(kmeans(&vs, 2, 50), kmeans(&vs, 2, 50));
    }

    #[test]
    fn store_clusters_fills_embeddings_and_clusters() {
        let mut conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        for p in ["a.md", "b.md", "c.md", "d.md"] {
            conn.execute(
                "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at)
                 VALUES (?1,'T','h',0,1,0)",
                rusqlite::params![p],
            )
            .unwrap();
        }
        let items = vec![
            ("a.md".to_string(), vec![0.0, 0.0]),
            ("b.md".to_string(), vec![0.1, 0.0]),
            ("c.md".to_string(), vec![9.0, 9.0]),
            ("d.md".to_string(), vec![9.1, 9.0]),
        ];
        let n = store_clusters(&mut conn, &items, 2, "test", 0).unwrap();
        assert!(n >= 2, "two well-separated groups should yield >=2 clusters");

        let emb: i64 = conn
            .query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(emb, 4);

        // get_clusters (the MCP/graph read path) sees all 4 members, and a/b share a
        // cluster while c/d share the other.
        let groups = crate::db::queries::get_clusters(&conn).unwrap();
        let total: usize = groups.iter().map(|g| g.members.len()).sum();
        assert_eq!(total, 4);
        let cluster_of = |path: &str| -> i64 {
            conn.query_row(
                "SELECT cluster_id FROM clusters WHERE path=?1",
                rusqlite::params![path],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(cluster_of("a.md"), cluster_of("b.md"));
        assert_eq!(cluster_of("c.md"), cluster_of("d.md"));
        assert_ne!(cluster_of("a.md"), cluster_of("c.md"));
    }

    #[test]
    fn store_clusters_skips_paths_deleted_mid_recompute() {
        let mut conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        // only a.md still exists; ghost.md was read before the embed but deleted since.
        conn.execute(
            "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at) VALUES ('a.md','T','h',0,1,0)",
            [],
        )
        .unwrap();
        let items = vec![
            ("a.md".to_string(), vec![0.0, 0.0]),
            ("ghost.md".to_string(), vec![9.0, 9.0]),
        ];
        // must NOT error (FK skip), and must store only the surviving note.
        store_clusters(&mut conn, &items, 2, "test", 0).unwrap();
        let emb: i64 = conn
            .query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(emb, 1, "only the surviving note is stored");
        let ghost: i64 = conn
            .query_row("SELECT COUNT(*) FROM clusters WHERE path='ghost.md'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ghost, 0);
    }

    /// Full Phase-11 pipeline with the REAL neural model: two distinct topics (cooking
    /// vs astrophysics) must land in different semantic clusters. #[ignore]d — uses the
    /// cached ONNX model; run with `--ignored`.
    #[test]
    #[ignore = "uses the real ONNX model (cached after the embed spike); run with --ignored"]
    fn full_pipeline_separates_topics_semantically() {
        let mut conn = crate::db::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        let seed = [
            ("cooking.md", "Cooking Pasta", "boil water add salt cook the pasta al dente then drain and serve"),
            ("sauce.md", "Tomato Sauce", "simmer tomatoes garlic basil and olive oil into a pasta sauce"),
            ("holes.md", "Black Holes", "a black hole bends spacetime so light cannot escape the event horizon"),
            ("stars.md", "Neutron Stars", "a neutron star is the dense collapsed core left by a massive star"),
        ];
        for (p, t, b) in seed {
            conn.execute(
                "INSERT INTO notes (path,title,content_hash,mtime,word_count,indexed_at) VALUES (?1,?2,'h',0,1,0)",
                rusqlite::params![p, t],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO notes_fts (path,title,body) VALUES (?1,?2,?3)",
                rusqlite::params![p, t, b],
            )
            .unwrap();
        }
        let rows = read_texts(&conn).unwrap();
        let texts: Vec<String> = rows.iter().map(|(_, t)| t.clone()).collect();
        let dir = std::env::temp_dir().join("rg-fastembed-cache");
        let mut model = crate::embed::new_model(&dir).unwrap();
        let vectors = crate::embed::embed_texts(&mut model, &texts).unwrap();
        let items: Vec<(String, Vec<f32>)> = rows.into_iter().map(|(p, _)| p).zip(vectors).collect();
        store_clusters(&mut conn, &items, 2, "test", 0).unwrap();

        let cl = |p: &str| -> i64 {
            conn.query_row(
                "SELECT cluster_id FROM clusters WHERE path=?1",
                rusqlite::params![p],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(cl("cooking.md"), cl("sauce.md"), "two cooking notes should cluster together");
        assert_eq!(cl("holes.md"), cl("stars.md"), "two astro notes should cluster together");
        assert_ne!(cl("cooking.md"), cl("holes.md"), "cooking vs astrophysics should separate");
    }
}
