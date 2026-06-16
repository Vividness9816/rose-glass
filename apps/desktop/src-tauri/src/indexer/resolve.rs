//! Link resolution against the whole-vault note set. One function used by BOTH
//! the full-rebuild pass-2 and incremental — this single source of truth is what
//! makes the two paths produce identical output (the A3 invariant).

use std::collections::HashMap;

pub struct NoteIndex {
    by_stem: HashMap<String, Vec<String>>, // lowercased filename stem -> rel paths
    by_relpath: HashMap<String, String>,   // lowercased relpath (with + without .md) -> rel path
}

fn strip_md(s: &str) -> Option<&str> {
    s.strip_suffix(".markdown").or_else(|| s.strip_suffix(".md"))
}

fn stem_of(path: &str) -> &str {
    let file = path.rsplit('/').next().unwrap_or(path);
    strip_md(file).unwrap_or(file)
}

impl NoteIndex {
    pub fn build(paths: &[String]) -> Self {
        let mut idx = NoteIndex {
            by_stem: HashMap::new(),
            by_relpath: HashMap::new(),
        };
        for p in paths {
            idx.add(p);
        }
        idx
    }

    pub fn add(&mut self, path: &str) {
        let lower = path.to_lowercase();
        self.by_relpath.insert(lower.clone(), path.to_string());
        if let Some(stripped) = strip_md(&lower) {
            self.by_relpath
                .insert(stripped.to_string(), path.to_string());
        }
        let stem = stem_of(path).to_lowercase();
        self.by_stem.entry(stem).or_default().push(path.to_string());
    }
}

/// `target` already has alias/#heading stripped (by `parse`). A '/'-containing
/// target resolves by relpath; otherwise by filename stem. Case-insensitive.
/// Multiple stem matches → lexicographically smallest path (deterministic).
/// Empty target ("[[#heading]]") → the source note itself. No match → None (dangling).
pub fn resolve(target: &str, src_path: &str, idx: &NoteIndex) -> Option<String> {
    let t = target.trim();
    if t.is_empty() {
        return Some(src_path.to_string());
    }
    let lower = t.replace('\\', "/").to_lowercase();

    if lower.contains('/') {
        if let Some(p) = idx.by_relpath.get(&lower) {
            return Some(p.clone());
        }
        let with_md = format!("{lower}.md");
        return idx.by_relpath.get(&with_md).cloned();
    }

    let stem = strip_md(&lower).unwrap_or(&lower);
    idx.by_stem.get(stem).and_then(|v| v.iter().min().cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx() -> NoteIndex {
        NoteIndex::build(&[
            "a.md".into(),
            "sub/b.md".into(),
            "a/Note.md".into(),
            "b/Note.md".into(),
        ])
    }

    #[test]
    fn stem_path_case_self_and_dangling() {
        let i = idx();
        assert_eq!(resolve("a", "x.md", &i), Some("a.md".into())); // stem
        assert_eq!(resolve("sub/b", "x.md", &i), Some("sub/b.md".into())); // relpath
        assert_eq!(resolve("SUB/B.md", "x.md", &i), Some("sub/b.md".into())); // case + ext
        assert_eq!(resolve("", "self.md", &i), Some("self.md".into())); // [[#heading]] -> self
        assert_eq!(resolve("ghost", "x.md", &i), None); // dangling
    }

    #[test]
    fn tie_break_is_lexicographically_smallest() {
        let i = idx();
        // both a/Note.md and b/Note.md share stem "note" -> deterministic smallest
        assert_eq!(resolve("Note", "x.md", &i), Some("a/Note.md".into()));
    }
}
