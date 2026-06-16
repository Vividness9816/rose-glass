pub mod hash;
pub mod parse;
pub mod pipeline;
pub mod resolve;

pub use parse::{parse_note, LinkType, ParsedNote, RawLink};
pub use resolve::{resolve, NoteIndex};

/// A link whose destination has been resolved against the vault note set.
/// `dst_path == None` means dangling (target not found); `dst_raw` is preserved.
#[derive(Debug, Clone)]
pub struct ResolvedLink {
    pub dst_path: Option<String>,
    pub dst_raw: String,
    pub link_type: LinkType,
}

/// Outcome of a single index operation (drives the watcher's emitted events).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexOutcome {
    Indexed,
    Skipped,
    Deleted,
}
