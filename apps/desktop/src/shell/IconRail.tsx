/* 52px icon rail (mockup .sidebar). Active = rose-glow bg + 2px left indicator.
   Controlled by Shell: clicking Activity swaps the right pane to the Activity
   mirror (Phase 8); other items just move the highlight until their pane lands. */

import { Icon, type IconName } from '../icons/Icon';

interface RailItem {
  id: string;
  icon: IconName;
  title: string;
}

const TOP: RailItem[] = [
  { id: 'graph', icon: 'graph', title: 'Graph' },
  { id: 'notes', icon: 'notes', title: 'Notes' },
  { id: 'search', icon: 'search', title: 'Search' },
  { id: 'tags', icon: 'tags', title: 'Tags' },
];

const BOTTOM: RailItem[] = [
  { id: 'activity', icon: 'activity', title: 'Claude Activity' },
  { id: 'settings', icon: 'settings', title: 'Settings' },
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
      aria-label={it.title}
      type="button"
      onClick={() => onSelect(it.id)}
    >
      <Icon name={it.icon} size="md" />
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
