//! Local neural embeddings (Phase 11): all-MiniLM-L6-v2 via fastembed/ONNX. Offline
//! after a one-time model fetch. 384-dim f32 vectors, stored as BLOBs in `embeddings`,
//! then k-means-clustered into `clusters`. sqlite-vec (vector KNN search) is deferred —
//! clustering only needs to read the vectors back into Rust.

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use std::path::Path;
use std::sync::Mutex;

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

/// Decode half of the codec — used by `queries::read_embeddings` (Phase 13 KNN search).
pub fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// The cached embedding model + its load state, held in `AppState` (v2.0). The ~90MB
/// model loads ONCE and is reused; a FAILED load is remembered so search doesn't silently
/// re-download on every call (the UI surfaces a Retry that calls `reset_model`). Held
/// behind a Mutex because `embed()` needs `&mut` AND because serializing the build avoids
/// the cache-dir race two concurrent `new_model()` calls would hit.
#[derive(Default)]
pub enum ModelCache {
    #[default]
    Uninit,
    Ready(TextEmbedding),
    Failed(String),
}

/// Lazily build the model once, then run `f` against it. A prior failure short-circuits
/// (returns the cached error, NO re-download). `cache_dir` holds the downloaded ONNX model
/// (outside the vault). ponytail: we rely on hf-hub's own HTTP timeouts for the fetch — we
/// do NOT spawn a kill-able download thread, because `recv_timeout` cannot cancel it and
/// would orphan a writer racing a cache wipe (see ADR-20260618-rose-glass-v2-architecture).
/// We never wipe the cache dir: a partial download completes on a later attempt.
pub fn with_model<T>(
    cache: &Mutex<ModelCache>,
    cache_dir: &Path,
    f: impl FnOnce(&mut TextEmbedding) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    match &*guard {
        ModelCache::Failed(e) => return Err(e.clone()),
        ModelCache::Uninit => match new_model(cache_dir) {
            Ok(m) => *guard = ModelCache::Ready(m),
            Err(e) => {
                *guard = ModelCache::Failed(e.clone());
                return Err(e);
            }
        },
        ModelCache::Ready(_) => {}
    }
    match &mut *guard {
        ModelCache::Ready(m) => f(m),
        _ => unreachable!("set Ready or returned above"),
    }
}

/// Drop a cached model / clear a remembered failure so the next `with_model` rebuilds —
/// the "Retry" affordance after a failed model fetch.
pub fn reset_model(cache: &Mutex<ModelCache>) {
    *cache.lock().unwrap_or_else(|e| e.into_inner()) = ModelCache::Uninit;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_cache_short_circuits_without_rebuild() {
        // The council-critical path: a remembered failure must NOT re-download, and the
        // embed closure must not run (it only runs on Ready).
        let cache = Mutex::new(ModelCache::Failed("boom".into()));
        let mut ran = false;
        let r: Result<(), String> = with_model(&cache, Path::new("/nonexistent"), |_m| {
            ran = true;
            Ok(())
        });
        assert_eq!(r, Err("boom".to_string()));
        assert!(!ran, "closure must not run on a failed cache");
        // Retry resets the state so a later attempt rebuilds.
        reset_model(&cache);
        assert!(matches!(
            *cache.lock().unwrap_or_else(|e| e.into_inner()),
            ModelCache::Uninit
        ));
    }

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
