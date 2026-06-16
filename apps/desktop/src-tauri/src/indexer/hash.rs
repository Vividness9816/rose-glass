/// blake3 hex of the raw file bytes — the content-hash gate (spec §9). Fast,
/// non-crypto-overkill, and a hex string drops straight into `content_hash TEXT`.
pub fn content_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
