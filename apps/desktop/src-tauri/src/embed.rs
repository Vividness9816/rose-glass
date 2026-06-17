//! Local neural embeddings (Phase 11): all-MiniLM-L6-v2 via fastembed/ONNX. Offline
//! after a one-time model fetch. 384-dim f32 vectors, stored as BLOBs in `embeddings`,
//! then k-means-clustered into `clusters`. sqlite-vec (vector KNN search) is deferred —
//! clustering only needs to read the vectors back into Rust.

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use std::path::Path;

#[allow(dead_code)] // the model's output dim — asserted by the embed spike + documents the schema
pub const EMBED_DIM: usize = 384; // all-MiniLM-L6-v2
pub const MODEL_NAME: &str = "all-MiniLM-L6-v2";

/// Build the embedding model, caching the downloaded ONNX model under `cache_dir`
/// (so it's not re-fetched and lives outside the vault).
pub fn new_model(cache_dir: &Path) -> Result<TextEmbedding, String> {
    let opts = TextInitOptions::new(EmbeddingModel::AllMiniLML6V2).with_cache_dir(cache_dir.to_path_buf());
    TextEmbedding::try_new(opts).map_err(|e| e.to_string())
}

/// Embed a batch of note texts → one 384-dim vector each (order preserved). Generic over
/// the text type so callers can pass borrowed &str (no corpus copy) or owned String.
pub fn embed_texts<S: AsRef<str> + Send + Sync>(
    model: &mut TextEmbedding,
    texts: &[S],
) -> Result<Vec<Vec<f32>>, String> {
    model.embed(texts, None).map_err(|e| e.to_string())
}

/// Encode/decode an f32 vector as a little-endian BLOB for the `embeddings.vector` column.
pub fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

#[allow(dead_code)] // decode half of the codec — exercised by the round-trip test; re-cluster-without-re-embed will use it
pub fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_round_trips() {
        let v = vec![0.0f32, 1.5, -2.25, 3.125];
        assert_eq!(blob_to_vec(&vec_to_blob(&v)), v);
        // a real-length vector survives too
        let big: Vec<f32> = (0..EMBED_DIM).map(|i| i as f32 * 0.01).collect();
        assert_eq!(blob_to_vec(&vec_to_blob(&big)), big);
    }

    /// SPIKE (gating): local ONNX embedding must build + download + infer on this box.
    /// #[ignore]d — needs network + a ~90MB one-time model fetch; run with `--ignored`.
    #[test]
    #[ignore = "downloads ~90MB model + ONNX runtime on first run; run explicitly with --ignored"]
    fn embed_spike_produces_384dim() {
        let dir = std::env::temp_dir().join("rg-fastembed-cache");
        let mut model = new_model(&dir).expect("model init (build + download)");
        let out = embed_texts(
            &mut model,
            &["the brain prunes unused synapses during sleep".to_string()],
        )
        .expect("embed");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), EMBED_DIM);
        assert!(out[0].iter().any(|x| *x != 0.0), "embedding was all zeros");
    }
}
