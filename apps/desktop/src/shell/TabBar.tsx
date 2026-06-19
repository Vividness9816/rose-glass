/* v2.3 — document tab strip above the editor (note/binary tabs). The tab list + transitions
   live in Shell via the pure tabs.ts; this is presentational. Mirrors the terminal-tab look. */
import { Icon } from '../icons/Icon';
import type { Tab } from './tabs';

function leaf(path: string): string {
  return path.split('/').pop() || path;
}

export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
}: {
  tabs: Tab[];
  activeId: number | null;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div className="editor-tabs" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`editor-tab${t.id === activeId ? ' active' : ''}`}
          role="tab"
          aria-selected={t.id === activeId}
          title={t.path}
          onClick={() => onActivate(t.id)}
        >
          <Icon name="file" size={12} />
          <span className="editor-tab-label">{leaf(t.path)}</span>
          <button
            className="editor-tab-close"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
            title="Close tab"
            aria-label={`Close ${leaf(t.path)}`}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
