//! Phase 13: brute-force cosine KNN over the stored note embeddings.
//!
//! ADR-20260618 chose this over the sqlite-vec C extension: the 384-dim f32 vectors
//! already live as BLOBs in `embeddings` and a linear scan is sub-perceptible for a
//! personal vault (a 384-dim dot over even 10k notes ≈ 3.84M multiply-adds). sqlite-vec
//! / an in-memory HNSW is the named upgrade path IF a real vault crosses ~100k notes and
//! a *measured* query latency exceeds budget.
//!
//! This module is pure — no DB, no model — so it's deterministic and unit-testable. The
//! DB read lives in `queries::read_embeddings`; the query-embed (free-text search) and
//! the lock discipline live in `commands`.

/// One scored neighbour: a note path and its cosine similarity to the query
/// (−1..=1; 1.0 = identical direction).
#[derive(Debug, Clone)]
pub struct Scored {
    pub path: String,
    pub score: f32,
}

/// Cosine similarity = dot(a,b) / (‖a‖·‖b‖), computed directly. We do NOT assume the
/// vectors are pre-normalised — fastembed's L2-normalisation is a library property this
/// code never asserts (the embed spike checks dim + non-zero only), so a non-unit vector
/// still ranks correctly. A zero vector (a degenerate/failed embed) scores 0, never NaN.
/// Mismatched lengths score 0 (the caller also filters these out).
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

/// Top-`k` nearest neighbours of `query` in `corpus` by cosine, descending. Excludes
/// `exclude` (a note's own KNN must drop itself — otherwise it returns at rank-0 with
/// sim 1.0). Corpus vectors whose length differs from the query are skipped (guards a
/// model/dim change leaving stale wrong-length rows). `k == 0`, an empty query, or an
/// empty corpus → empty; `k` is clamped to the available count.
pub fn knn(
    query: &[f32],
    corpus: &[(String, Vec<f32>)],
    k: usize,
    exclude: Option<&str>,
) -> Vec<Scored> {
    if k == 0 || query.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<Scored> = corpus
        .iter()
        .filter(|(p, _)| exclude != Some(p.as_str()))
        .filter(|(_, v)| v.len() == query.len())
        .map(|(p, v)| Scored {
            path: p.clone(),
            score: cosine(query, v),
        })
        .collect();
    // Descending by score. cosine() never returns NaN (zero/mismatch → 0.0), so every
    // score is finite and partial_cmp is a total order here.
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(k);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    #[test]
    fn cosine_identical_is_one_orthogonal_zero_opposite_negative() {
        assert!(approx(cosine(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]), 1.0));
        assert!(approx(cosine(&[2.0, 4.0, 6.0], &[1.0, 2.0, 3.0]), 1.0)); // same direction, different magnitude
        assert!(approx(cosine(&[1.0, 0.0], &[0.0, 1.0]), 0.0));
        assert!(approx(cosine(&[1.0, 0.0], &[-1.0, 0.0]), -1.0));
    }

    #[test]
    fn cosine_guards_zero_and_mismatched_length() {
        assert_eq!(cosine(&[0.0, 0.0], &[1.0, 2.0]), 0.0); // zero vector → 0, not NaN
        assert!(!cosine(&[0.0, 0.0], &[1.0, 2.0]).is_nan());
        assert_eq!(cosine(&[1.0, 2.0, 3.0], &[1.0, 2.0]), 0.0); // length mismatch → 0
    }

    fn corpus() -> Vec<(String, Vec<f32>)> {
        vec![
            ("near.md".into(), vec![1.0, 0.1, 0.0]),  // close to query [1,0,0]
            ("mid.md".into(), vec![0.5, 0.5, 0.0]),   // 45° off
            ("far.md".into(), vec![0.0, 0.0, 1.0]),   // orthogonal
            ("self.md".into(), vec![1.0, 0.0, 0.0]),  // identical to query
        ]
    }

    #[test]
    fn knn_ranks_near_above_far() {
        let hits = knn(&[1.0, 0.0, 0.0], &corpus(), 3, None);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].path, "self.md"); // identical wins
        assert_eq!(hits[1].path, "near.md");
        assert_eq!(hits[2].path, "mid.md"); // far.md (orthogonal) drops out of top-3
        // monotonically non-increasing
        assert!(hits[0].score >= hits[1].score && hits[1].score >= hits[2].score);
    }

    #[test]
    fn knn_excludes_self() {
        let hits = knn(&[1.0, 0.0, 0.0], &corpus(), 5, Some("self.md"));
        assert!(hits.iter().all(|h| h.path != "self.md"));
        assert_eq!(hits[0].path, "near.md"); // self dropped → near is now first
    }

    #[test]
    fn knn_clamps_k_and_handles_empty() {
        assert!(knn(&[1.0, 0.0, 0.0], &corpus(), 0, None).is_empty()); // k=0
        assert!(knn(&[], &corpus(), 3, None).is_empty()); // empty query
        assert!(knn(&[1.0, 0.0, 0.0], &[], 3, None).is_empty()); // empty corpus
        assert_eq!(knn(&[1.0, 0.0, 0.0], &corpus(), 99, None).len(), 4); // k > n clamps to n
    }

    #[test]
    fn knn_skips_dim_mismatched_rows() {
        let mut c = corpus();
        c.push(("wrongdim.md".into(), vec![1.0, 0.0])); // 2-dim row among 3-dim
        let hits = knn(&[1.0, 0.0, 0.0], &c, 99, None);
        assert!(hits.iter().all(|h| h.path != "wrongdim.md"));
        assert_eq!(hits.len(), 4); // the 4 valid rows, the mismatched one skipped
    }
}
