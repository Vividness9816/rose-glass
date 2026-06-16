/* 52px icon rail (mockup .sidebar). Active = rose-glow bg + 2px left indicator.
   Navigation wiring lands with the panes it switches; here the active item is
   static (Graph) to match the mockup. */

import { useState } from 'react';

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

export function IconRail() {
  const [active, setActive] = useState('graph');
  const renderItem = (it: RailItem) => (
    <button
      key={it.id}
      className={`sb-icon${active === it.id ? ' active' : ''}`}
      title={it.title}
      type="button"
      onClick={() => setActive(it.id)}
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
