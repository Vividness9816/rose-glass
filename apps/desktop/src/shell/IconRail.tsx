/* 52px icon rail (mockup .sidebar). Active = rose-glow bg + 2px left indicator.
   Controlled by Shell: clicking ◎ Activity swaps the right pane to the Activity
   mirror (Phase 8); other items just move the highlight until their pane lands. */

interface RailItem {
  id: string;
  glyph: string;
  title: string;
}

const TOP: RailItem[] = [
  { id: 'graph', glyph: '⬡', title: 'Graph' },
  { id: 'notes', glyph: '≡', title: 'Notes' },
  { id: 'search', glyph: '⌕', title: 'Search' },
  { id: 'tags', glyph: '◈', title: 'Tags' },
];

const BOTTOM: RailItem[] = [
  { id: 'activity', glyph: '◎', title: 'Claude Activity' },
  { id: 'settings', glyph: '⚙', title: 'Settings' },
];

export function IconRail({
  active,
  onSelect,
}: {
  active: string;
  onSelect: (id: string) => void;
}) {
  const renderItem = (it: RailItem) => (
    <button
      key={it.id}
      className={`sb-icon${active === it.id ? ' active' : ''}`}
      title={it.title}
      type="button"
      onClick={() => onSelect(it.id)}
    >
      {it.glyph}
    </button>
  );
  return (
    <div className="sidebar">
      {TOP.map(renderItem)}
      <div className="sb-spacer" />
      {BOTTOM.map(renderItem)}
    </div>
  );
}
