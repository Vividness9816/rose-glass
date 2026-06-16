import { useEffect, useRef, useState } from 'react';
import { search, type SearchHit } from '../ipc';
import { clampIndex } from './logic';
import './palette.css';

interface Props {
  onClose: () => void;
  onOpenNote: (path: string) => void;
}

/** ⌘K command palette — debounced FTS search over the vault; ↑↓ to move, Enter to
 *  open, Esc to close. Renders the mockup's glass palette. */
export function CommandPalette({ onClose, onOpenNote }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [focus, setFocus] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // debounced search; ignore stale responses
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setFocus(0);
      return;
    }
    let active = true;
    const t = setTimeout(async () => {
      try {
        const hits = await search(q);
        if (active) {
          setResults(hits);
          setFocus(0);
        }
      } catch {
        if (active) setResults([]); // no vault / not under Tauri
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
    if (e.key === 'Escape') {
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

  const showEmpty = query.trim().length > 0 && results.length === 0;

  return (
    <div className="cmd-overlay" onMouseDown={onClose}>
      <div
        className="cmd-palette"
        role="dialog"
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
          <div className="cmd-results">
            {results.map((hit, i) => (
              <div
                key={hit.path}
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
                  <div className="cmd-result-sub">{hit.path}</div>
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

        {showEmpty && (
          <div className="cmd-results">
            <div className="cmd-empty">No results</div>
          </div>
        )}
      </div>
    </div>
  );
}
