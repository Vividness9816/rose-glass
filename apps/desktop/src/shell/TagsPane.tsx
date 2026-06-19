/* Tags pane (rail ◈) — a tag browser over the indexer's tag counts. Clicking a tag
   searches for it (via the command palette). Fetches once on mount. */

import { useEffect, useState } from 'react';
import { getTags, inTauri, type TagCount } from '../ipc';
import { Icon } from '../icons/Icon';
import './panes.css';

export function TagsPane({ onTag }: { onTag: (tag: string) => void }) {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!inTauri()) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    getTags()
      .then((t) => {
        if (!cancelled) setTags(t);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = [...tags].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return (
    <div className="side-pane">
      <div className="sp-header">
        <span className="sp-glyph">
          <Icon name="tags" size="sm" />
        </span>
        <span className="sp-title">tags</span>
        <span className="sp-count">{tags.length}</span>
      </div>
      <div className="sp-list">
        {loaded && sorted.length === 0 ? (
          <div className="sp-empty">No tags yet. Add #tags to your notes and they&apos;ll appear here.</div>
        ) : (
          sorted.map((t) => (
            <button
              key={t.tag}
              type="button"
              className="sp-row sp-tag-row"
              onClick={() => onTag(t.tag)}
              title={`Search notes tagged #${t.tag}`}
            >
              <span className="sp-tag">#{t.tag}</span>
              <span className="sp-tag-count">{t.count}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
