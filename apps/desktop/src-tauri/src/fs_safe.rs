//! Path safety for the editor save/read path. The frontend sends vault-relative,
//! forward-slash paths; we GUARANTEE the resolved absolute path stays inside the
//! vault root (rejects absolute, `..`, and symlinked-dir escapes).

use std::path::{Component, Path, PathBuf};

pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("absolute paths are not allowed".into());
    }
    if rel_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("path traversal ('..') is not allowed".into());
    }
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("vault root unavailable: {e}"))?;
    let joined = root_canon.join(rel_path);
    let check = match joined.canonicalize() {
        Ok(c) => c, // existing file (read / overwrite)
        Err(_) => {
            // new file: canonicalize the PARENT so a symlinked dir can't escape
            let parent = joined.parent().ok_or("invalid path")?;
            let name = joined.file_name().ok_or("invalid path")?;
            parent
                .canonicalize()
                .map_err(|e| format!("parent dir unavailable: {e}"))?
                .join(name)
        }
    };
    if !check.starts_with(&root_canon) {
        return Err("path escapes the vault root".into());
    }
    Ok(check)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_paths_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("note.md"), b"x").unwrap();
        assert!(safe_join(root, "note.md").is_ok());

        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/note.md"), b"x").unwrap();
        assert!(safe_join(root, "sub/note.md").is_ok());

        // new file under an existing dir is allowed (parent canonicalizes)
        assert!(safe_join(root, "sub/new.md").is_ok());
    }

    #[test]
    fn rejects_escapes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(safe_join(root, "../escape.md").is_err());
        assert!(safe_join(root, "sub/../../escape.md").is_err());
        // absolute path
        let abs = if cfg!(windows) { "C:/Windows/system.ini" } else { "/etc/passwd" };
        assert!(safe_join(root, abs).is_err());
    }

    #[test]
    fn rejects_sibling_prefix_trick() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let base = root.file_name().unwrap().to_str().unwrap().to_string();
        // a sibling dir sharing a string prefix must not pass starts_with
        assert!(safe_join(root, &format!("../{base}-evil/x.md")).is_err());
    }
}
