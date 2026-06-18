import { useEffect, useRef, useState } from 'react';
import { search, type SearchHit } from '../ipc';
import { clampIndex } from './logic';
import './palette.css';

interface Props {
  onClose: () => void;
  onOpenNote: (path: string) => void;
  /** Pre-fill the search (e.g. opened from a tag) — the debounced search runs on it. */
  initialQuery?: string;
}

const stripHighlight = (s: string) => s.replace(/<\/?b>/g, '');

/** ⌘K command palette — debounced FTS search; ↑↓ to move, Enter to open, Esc to
 *  close. Renders the mockup's glass palette. */
export function CommandPalette({ onClose, onOpenNote, initialQuery }: Props) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [focus, setFocus] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // debounced search; the `active` flag drops stale responses
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setFocus(0);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const hits = await search(q);
        if (active) {
          setResults(hits);
          setFocus(0);
        }
      } catch {
        if (active) setResults([]); // no vault / not under Tauri
      } finally {
        if (active) setLoading(false);
      }
    }, 120);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [query]);

  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onOpenNote(hit.path);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // own the hotkey so it doesn't bubble to the global handler and re-toggle
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocus((f) => clampIndex(f + 1, results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocus((f) => clampIndex(f - 1, results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[focus]);
    }
  };

  const trimmed = query.trim();

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="cmd-input-row">
          <span className="cmd-icon">⌕</span>
          <input
            ref={inputRef}
            className="cmd-input"
            placeholder="Search notes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="kbd">esc</div>
        </div>

        {results.length > 0 && (
          <div className="cmd-results" role="listbox">
            {results.map((hit, i) => (
              <div
                key={hit.path}
                role="option"
                aria-selected={i === focus}
                className={`cmd-result${i === focus ? ' focused' : ''}`}
                onMouseEnter={() => setFocus(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(hit);
                }}
              >
                <div className="cmd-result-icon">📄</div>
                <div>
                  <div className="cmd-result-title">{hit.title}</div>
                  <div className="cmd-result-sub">
                    {hit.snippet ? stripHighlight(hit.snippet) : hit.path}
                  </div>
                </div>
                {i === focus && (
                  <div className="cmd-result-kbd">
                    <div className="kbd">↵</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {trimmed.length > 0 && results.length === 0 && (
          <div className="cmd-results">
            <div className="cmd-empty">{loading ? 'Searching…' : 'No results'}</div>
          </div>
        )}
      </div>
    </div>
  );
}
