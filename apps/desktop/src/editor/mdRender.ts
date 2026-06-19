/* Markdown → sanitized HTML for the reading view. A wikilink pre-pass turns [[t|a]] into a
   data-wikilink anchor (DOMPurify keeps data-* + class; a custom-scheme href would be
   stripped), then markdown-it renders, then DOMPurify sanitizes.
   ponytail: the wikilink regex also matches inside code fences (rare) — acceptable; a full
   AST pass is the upgrade if it bites. */
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** [[target]] / [[target|alias]] → an anchor the ReadingView delegates on click. */
function rewriteWikilinks(doc: string): string {
  return doc.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const t = target.trim();
    const label = (alias ?? target).trim();
    return `<a class="rg-wikilink" data-wikilink="${escapeHtml(t)}">${escapeHtml(label)}</a>`;
  });
}

export function mdRender(doc: string): string {
  const html = md.render(rewriteWikilinks(doc));
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
