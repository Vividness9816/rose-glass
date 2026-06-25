/* Statusbar (mockup .statusbar). The "Synced" item is decorative in the
   mockup; per §18 this is local-first so it reads "Local". Theme label is the
   live toggle. Counts are mock until the indexer lands. */

import type { Theme } from '../appearance/theme';
import { CountUp } from '../ui/CountUp';

interface Props {
  notes: number;
  links: number;
  clusters: number;
  theme: Theme;
  onToggleTheme: () => void;
}

export function StatusBar({ notes, links, clusters, theme, onToggleTheme }: Props) {
  return (
    <div className="statusbar">
      <div className="sb-item">
        <div className="sb-dot" /> Live
      </div>
      <div className="sb-sep">·</div>
      <div className="sb-item"><CountUp value={notes} /> notes</div>
      <div className="sb-item"><CountUp value={links} /> links</div>
      <div className="sb-item"><CountUp value={clusters} /> clusters</div>
      <div className="sb-right">
        <button className="sb-item sb-theme" type="button" onClick={onToggleTheme}>
          {theme === 'dark' ? 'Dark' : 'Light'}
        </button>
        <div className="sb-item sb-live-dot">●</div>
        <div className="sb-item">Local</div>
      </div>
    </div>
  );
}
