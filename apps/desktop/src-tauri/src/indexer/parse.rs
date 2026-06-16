//! Pure markdown parsing — deterministic over input bytes, no FS, no vault lookup.
//! The `regex` crate has no lookaround, so we MASK (length-preserving, offset-stable)
//! code fences / inline code / URLs before extracting links, and additionally mask
//! links before extracting tags. That masking is what excludes `[[x]]`/`#tag` inside
//! code and `#frag` inside URLs.

use super::hash::content_hash;
use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkType {
    Wikilink,
    Markdown,
    Embed,
}

impl LinkType {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkType::Wikilink => "wikilink",
            LinkType::Markdown => "markdown",
            LinkType::Embed => "embed",
        }
    }
}

/// One outbound reference, destination NOT yet resolved.
#[derive(Debug, Clone)]
pub struct RawLink {
    pub dst_raw: String,
    pub target: String,
    pub link_type: LinkType,
}

#[derive(Debug, Clone)]
pub struct ParsedNote {
    pub title: String,
    pub frontmatter_json: Option<String>,
    pub content_hash: String,
    pub word_count: i64,
    pub fts_body: String,
    pub links: Vec<RawLink>,
    pub tags: Vec<String>,
}

static H1: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^#[ \t]+(.+?)[ \t]*#*[ \t]*$").unwrap());
static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)```.*?```").unwrap());
static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]*`").unwrap());
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[^\s)]+").unwrap());
static WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(!?)\[\[([^\[\]\n]+)\]\]").unwrap());
static MDLINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\[([^\[\]\n]*)\]\(([^()\s]+)(?:[ \t]+"[^"]*")?\)"#).unwrap()
});
static TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[^\w&;#/])#([\p{L}][\p{L}\p{N}/_-]*)").unwrap());

/// Blank the given byte ranges with spaces, preserving length + offsets. Ranges
/// come from regex matches (char-boundary aligned), so the result is valid UTF-8.
fn blank_ranges(s: &str, ranges: &[(usize, usize)]) -> String {
    let mut out = s.as_bytes().to_vec();
    for &(a, b) in ranges {
        for byte in out.iter_mut().take(b).skip(a) {
            *byte = b' ';
        }
    }
    String::from_utf8(out).expect("blanking with spaces preserves UTF-8 validity")
}

fn mask_code_and_urls(body: &str) -> String {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for re in [&*FENCE, &*INLINE_CODE, &*URL] {
        for m in re.find_iter(body) {
            ranges.push((m.start(), m.end()));
        }
    }
    blank_ranges(body, &ranges)
}

fn split_frontmatter(text: &str) -> (Option<String>, String) {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut first = t.lines();
    if first.next().map(str::trim_end) != Some("---") {
        return (None, t.to_string());
    }
    let mut fm = String::new();
    let mut body = String::new();
    let mut in_body = false;
    let mut closed = false;
    for line in t.lines().skip(1) {
        if !in_body && matches!(line.trim_end(), "---" | "...") {
            in_body = true;
            closed = true;
            continue;
        }
        if in_body {
            body.push_str(line);
            body.push('\n');
        } else {
            fm.push_str(line);
            fm.push('\n');
        }
    }
    if closed {
        (Some(fm), body)
    } else {
        (None, t.to_string())
    }
}

fn parse_frontmatter_json(fm_src: Option<&str>) -> Option<serde_json::Value> {
    fm_src
        .and_then(|s| serde_yaml_ng::from_str::<serde_json::Value>(s).ok())
        .filter(|v| !v.is_null() && !matches!(v, serde_json::Value::String(s) if s.is_empty()))
}

fn norm_tag(raw: &str) -> Option<String> {
    let t = raw.trim().trim_start_matches('#').trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_lowercase())
    }
}

fn frontmatter_tags(fm: Option<&serde_json::Value>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(v) = fm.and_then(|m| m.get("tags")) {
        match v {
            serde_json::Value::Array(items) => {
                for it in items {
                    if let Some(s) = it.as_str() {
                        out.extend(norm_tag(s));
                    }
                }
            }
            serde_json::Value::String(s) => {
                for part in s.split([',', ' ', '\n']) {
                    out.extend(norm_tag(part));
                }
            }
            _ => {}
        }
    }
    out
}

fn title(fm: Option<&serde_json::Value>, body: &str, rel_path: &str) -> String {
    if let Some(t) = fm
        .and_then(|m| m.get("title"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return t.to_string();
    }
    if let Some(c) = H1.captures(body) {
        let h = c[1].trim();
        if !h.is_empty() {
            return h.to_string();
        }
    }
    let stem = rel_path.rsplit('/').next().unwrap_or(rel_path);
    stem.strip_suffix(".markdown")
        .or_else(|| stem.strip_suffix(".md"))
        .unwrap_or(stem)
        .to_string()
}

/// Strip an optional `#heading` and `|alias`, returning (resolution_target, raw_target).
fn split_wikilink_inner(inner: &str) -> (String, String) {
    let before_alias = inner.split('|').next().unwrap_or(inner);
    let target = before_alias.split('#').next().unwrap_or(before_alias).trim();
    (target.to_string(), before_alias.trim().to_string())
}

fn extract_links(masked: &str, body: &str) -> Vec<RawLink> {
    let mut links = Vec::new();

    for c in WIKILINK.captures_iter(masked) {
        let is_embed = c.get(1).map(|m| m.as_str() == "!").unwrap_or(false);
        let inner = &c[2];
        let (target, dst_raw) = split_wikilink_inner(inner);
        links.push(RawLink {
            dst_raw,
            target,
            link_type: if is_embed {
                LinkType::Embed
            } else {
                LinkType::Wikilink
            },
        });
    }

    for c in MDLINK.captures_iter(masked) {
        let m = c.get(0).unwrap();
        // image `![text](url)` — preceding byte is '!'
        if m.start() > 0 && body.as_bytes()[m.start() - 1] == b'!' {
            continue;
        }
        let url = c[2].trim();
        if url.is_empty() || url.contains("://") || url.starts_with('#') {
            continue; // external / intra-page anchor — not a vault link
        }
        links.push(RawLink {
            dst_raw: url.to_string(),
            target: url.to_string(),
            link_type: LinkType::Markdown,
        });
    }

    links
}

fn extract_tags(masked_code_urls: &str, fm: Option<&serde_json::Value>) -> Vec<String> {
    // additionally blank link spans so `[[Note#tag]]` / link URLs don't yield tags
    let mut link_ranges: Vec<(usize, usize)> = Vec::new();
    for m in WIKILINK.find_iter(masked_code_urls) {
        link_ranges.push((m.start(), m.end()));
    }
    for m in MDLINK.find_iter(masked_code_urls) {
        link_ranges.push((m.start(), m.end()));
    }
    let tag_src = blank_ranges(masked_code_urls, &link_ranges);

    let mut tags: Vec<String> = TAG
        .captures_iter(&tag_src)
        .filter_map(|c| norm_tag(&c[2]))
        .collect();
    tags.extend(frontmatter_tags(fm));
    tags.sort();
    tags.dedup();
    tags
}

/// Searchable prose: frontmatter already stripped; wikilinks→display text,
/// markdown links→link text, structural markdown chars→space.
fn fts_body(body: &str) -> String {
    let s = WIKILINK.replace_all(body, |c: &regex::Captures| {
        let inner = &c[2];
        // display = alias if present, else target (sans #heading)
        if let Some((_, alias)) = inner.split_once('|') {
            alias.trim().to_string()
        } else {
            inner.split('#').next().unwrap_or(inner).trim().to_string()
        }
    });
    let s = MDLINK.replace_all(&s, |c: &regex::Captures| c[1].to_string());
    s.chars()
        .map(|ch| if "#*`_>[]()".contains(ch) { ' ' } else { ch })
        .collect()
}

pub fn parse_note(rel_path: &str, bytes: &[u8]) -> ParsedNote {
    let hash = content_hash(bytes);
    let text = String::from_utf8_lossy(bytes);
    let (fm_src, body) = split_frontmatter(&text);
    let fm = parse_frontmatter_json(fm_src.as_deref());
    let frontmatter_json = fm.as_ref().map(|v| serde_json::to_string(v).unwrap());

    let title = title(fm.as_ref(), &body, rel_path);
    let masked = mask_code_and_urls(&body);
    let links = extract_links(&masked, &body);
    let tags = extract_tags(&masked, fm.as_ref());
    let fts = fts_body(&body);
    let word_count = fts.split_whitespace().count() as i64;

    ParsedNote {
        title,
        frontmatter_json,
        content_hash: hash,
        word_count,
        fts_body: fts,
        links,
        tags,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_tag(p: &ParsedNote, t: &str) -> bool {
        p.tags.iter().any(|x| x == t)
    }
    fn has_link(p: &ParsedNote, target: &str, kind: LinkType) -> bool {
        p.links.iter().any(|l| l.target == target && l.link_type == kind)
    }

    #[test]
    fn title_precedence() {
        assert_eq!(
            parse_note("n.md", b"---\ntitle: FM\n---\n# H1\nbody").title,
            "FM"
        );
        assert_eq!(parse_note("n.md", b"# H1 Title\nbody").title, "H1 Title");
        assert_eq!(parse_note("folder/my-note.md", b"just body").title, "my-note");
    }

    #[test]
    fn frontmatter_to_json_and_malformed_degrades() {
        let p = parse_note("n.md", b"---\ntitle: A\ntags: [x]\n---\nbody");
        let v: serde_json::Value =
            serde_json::from_str(p.frontmatter_json.as_ref().unwrap()).unwrap();
        assert_eq!(v["title"], "A");

        // malformed YAML must not panic and must not block body parsing
        let p = parse_note("n.md", b"---\nkey: [unclosed\n---\nbody #realtag");
        assert!(p.frontmatter_json.is_none());
        assert!(has_tag(&p, "realtag"));
    }

    #[test]
    fn tags_inline_and_frontmatter() {
        let p = parse_note("n.md", b"---\ntags: [Alpha, beta]\n---\nbody #gamma #project/sub");
        for t in ["alpha", "beta", "gamma", "project/sub"] {
            assert!(has_tag(&p, t), "missing tag {t}");
        }
        // rejects: leading digit, #-after-word, double-#
        let p = parse_note("n.md", b"#123 a#b ##h2");
        assert!(p.tags.is_empty(), "got {:?}", p.tags);
    }

    #[test]
    fn tag_inside_wikilink_ignored() {
        let p = parse_note("n.md", b"See [[Note#section]] only.");
        assert!(!has_tag(&p, "section"));
    }

    #[test]
    fn links_classify() {
        let p = parse_note(
            "n.md",
            b"[[b]] [link](c.md) ![[c]] ![img](pic.png) [ext](https://x.com)",
        );
        assert!(has_link(&p, "b", LinkType::Wikilink));
        assert!(has_link(&p, "c.md", LinkType::Markdown));
        assert!(has_link(&p, "c", LinkType::Embed));
        assert!(!p.links.iter().any(|l| l.target == "pic.png")); // image dropped
        assert!(!p.links.iter().any(|l| l.target.contains("x.com"))); // external dropped
    }

    #[test]
    fn code_fence_masks_links_and_tags() {
        let p = parse_note("n.md", b"text\n```\n[[x]] #y\n```\nmore #z");
        assert!(!p.links.iter().any(|l| l.target == "x"));
        assert!(!has_tag(&p, "y"));
        assert!(has_tag(&p, "z"));
    }

    #[test]
    fn url_fragment_is_not_a_tag() {
        let p = parse_note("n.md", b"See https://example.com/page#section then #real");
        assert!(!has_tag(&p, "section"));
        assert!(has_tag(&p, "real"));
    }

    #[test]
    fn word_count_and_hash_stable() {
        assert_eq!(parse_note("n.md", b"one two three").word_count, 3);
        // hash is over raw bytes — path-independent
        assert_eq!(
            parse_note("a.md", b"abc").content_hash,
            parse_note("z.md", b"abc").content_hash
        );
        assert_ne!(
            parse_note("a.md", b"abc").content_hash,
            parse_note("a.md", b"abd").content_hash
        );
    }
}
