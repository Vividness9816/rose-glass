/* v2.2 — the one icon source. A curated in-repo inline-SVG set (no dependency), all on a
   24 grid, fill:none, stroke:currentColor, 1.5px stroke, round caps/joins, aria-hidden. The
   stroke stays 1.5px at EVERY size so the set reads as one family; size via the --icon-*
   tokens (sm/md/lg = 13/15/18) or an explicit px. The accessible name lives on the
   interactive parent (button title/aria-label) — the SVG is decorative. Replaces the prior
   mix of emoji + unicode glyphs (one row alone had 📅 + ⟳ + ◈ + ↙). Absorbs SlidersIcon. */

import type { ReactNode } from 'react';

export type IconName =
  | 'graph'
  | 'notes'
  | 'search'
  | 'tags'
  | 'activity'
  | 'settings'
  | 'outline'
  | 'properties'
  | 'share'
  | 'file'
  | 'plus'
  | 'fullscreen'
  | 'close'
  | 'chevronDown'
  | 'chevronRight'
  | 'warning'
  | 'calendar'
  | 'clock'
  | 'words'
  | 'backlink'
  | 'sliders'
  | 'book'
  | 'edit';

// A zero-length round-capped line renders as a dot (the lucide trick), used for info/alert.
const PATHS: Record<IconName, ReactNode> = {
  graph: <polygon points="12 2.5 20.5 7.25 20.5 16.75 12 21.5 3.5 16.75 3.5 7.25" />,
  notes: (
    <>
      <line x1="5" y1="7" x2="19" y2="7" />
      <line x1="5" y1="12" x2="19" y2="12" />
      <line x1="5" y1="17" x2="13" y2="17" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="20.5" y1="20.5" x2="16.5" y2="16.5" />
    </>
  ),
  tags: (
    <>
      <path d="M3.5 12.5V5A1.5 1.5 0 0 1 5 3.5h7.5L21 12l-7.5 7.5z" />
      <line x1="7.4" y1="7.4" x2="7.41" y2="7.4" />
    </>
  ),
  activity: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2 16.7 7.3M7.3 16.7 5.2 18.8" />
    </>
  ),
  outline: (
    <>
      <line x1="9" y1="7" x2="20" y2="7" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="17" x2="20" y2="17" />
      <line x1="4.5" y1="7" x2="4.51" y2="7" />
      <line x1="4.5" y1="12" x2="4.51" y2="12" />
      <line x1="4.5" y1="17" x2="4.51" y2="17" />
    </>
  ),
  properties: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>
  ),
  share: (
    <>
      <path d="M4 13v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6" />
      <polyline points="8 7 12 3 16 7" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </>
  ),
  file: (
    <>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M6 3h8l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    </>
  ),
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  fullscreen: (
    <>
      <path d="M4 9V5a1 1 0 0 1 1-1h4" />
      <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
      <path d="M4 15v4a1 1 0 0 0 1 1h4" />
      <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
    </>
  ),
  close: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  chevronDown: <polyline points="6 9.5 12 15.5 18 9.5" />,
  chevronRight: <polyline points="9.5 6 15.5 12 9.5 18" />,
  warning: (
    <>
      <path d="M12 4 2.5 20.5h19z" />
      <line x1="12" y1="10" x2="12" y2="14" />
      <line x1="12" y1="17.3" x2="12.01" y2="17.3" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="16" rx="2" />
      <line x1="3.5" y1="9.5" x2="20.5" y2="9.5" />
      <line x1="8" y1="2.5" x2="8" y2="6" />
      <line x1="16" y1="2.5" x2="16" y2="6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 16 14" />
    </>
  ),
  words: (
    <>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M6 3h8l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <line x1="8.5" y1="13" x2="14" y2="13" />
      <line x1="8.5" y1="16.5" x2="14" y2="16.5" />
    </>
  ),
  backlink: (
    <>
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </>
  ),
  sliders: (
    <>
      <line x1="21" y1="5" x2="13" y2="5" />
      <line x1="9" y1="5" x2="3" y2="5" />
      <line x1="13" y1="3" x2="13" y2="7" />
      <line x1="21" y1="12" x2="15" y2="12" />
      <line x1="11" y1="12" x2="3" y2="12" />
      <line x1="15" y1="10" x2="15" y2="14" />
      <line x1="21" y1="19" x2="11" y2="19" />
      <line x1="7" y1="19" x2="3" y2="19" />
      <line x1="11" y1="17" x2="11" y2="21" />
    </>
  ),
  book: (
    <>
      <path d="M12 6.5C10.4 5.2 8 4.5 4 4.5v13c4 0 6.4.7 8 2 1.6-1.3 4-2 8-2v-13c-4 0-6.4.7-8 2z" />
      <line x1="12" y1="6.5" x2="12" y2="20.5" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17.17z" />
      <line x1="14.5" y1="8" x2="17.5" y2="11" />
    </>
  ),
};

export function Icon({
  name,
  size = 'md',
  className,
}: {
  name: IconName;
  /** 'sm' | 'md' | 'lg' (the --icon-* tokens) or an explicit px number. */
  size?: 'sm' | 'md' | 'lg' | number;
  className?: string;
}) {
  const dim = typeof size === 'number' ? `${size}px` : `var(--icon-${size})`;
  return (
    <svg
      className={className}
      style={{ width: dim, height: dim, flexShrink: 0, verticalAlign: 'middle' }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
