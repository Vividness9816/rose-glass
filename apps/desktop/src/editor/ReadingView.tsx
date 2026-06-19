/* Read-only rendered-Markdown view (the Edit/Read 'Read' mode). mdRender sanitizes the
   HTML; we delegate clicks on [[wikilink]] anchors (data-wikilink) to the existing nav. */
import { useMemo } from 'react';
import { mdRender } from './mdRender';

export function ReadingView({
  doc,
  onWikiClick,
  className,
}: {
  doc: string;
  onWikiClick: (target: string) => void;
  className?: string;
}) {
  const html = useMemo(() => mdRender(doc), [doc]);
  return (
    <div
      className={`reading-view${className ? ` ${className}` : ''}`}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a.rg-wikilink');
        const target = a?.getAttribute('data-wikilink');
        if (target) {
          e.preventDefault();
          onWikiClick(target);
        }
      }}
      // sanitized by mdRender (DOMPurify) — safe to inject
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
