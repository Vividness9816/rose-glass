/* 52px icon rail (mockup .sidebar). Active = rose-glow bg + 2px left indicator.
   v2.4.1: dock-style VERTICAL magnification (reactbits Dock, adapted row→column) — items
   grow as the cursor nears them, springy. Reduced-motion pins them to base size.
   Controlled by Shell: clicking Activity swaps the right pane to the Activity mirror. */

import { useRef } from 'react';
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useReducedMotion,
  type MotionValue,
  type SpringOptions,
} from 'motion/react';
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

const BASE = 34; // resting size (matches .sb-icon)
const MAG = 46; // magnified size (< 52px rail so it never overflows the column)
const DISTANCE = 90; // px of vertical proximity over which magnification falls off
const SPRING: SpringOptions = { mass: 0.1, stiffness: 150, damping: 12 };

function RailButton({
  it,
  active,
  onSelect,
  mouseY,
  peak,
}: {
  it: RailItem;
  active: boolean;
  onSelect: (id: string) => void;
  mouseY: MotionValue<number>;
  peak: number; // MAG normally, BASE under reduced-motion
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const distance = useTransform(mouseY, (v) => {
    const rect = ref.current?.getBoundingClientRect();
    const center = rect ? rect.y + rect.height / 2 : 0;
    return v - center;
  });
  const target = useTransform(distance, [-DISTANCE, 0, DISTANCE], [BASE, peak, BASE]);
  const size = useSpring(target, SPRING);
  return (
    <motion.button
      ref={ref}
      style={{ width: size, height: size }}
      className={`sb-icon${active ? ' active' : ''}`}
      title={it.title}
      aria-label={it.title}
      type="button"
      onClick={() => onSelect(it.id)}
    >
      <Icon name={it.icon} size="md" />
    </motion.button>
  );
}

export function IconRail({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  const reduce = useReducedMotion();
  const peak = reduce ? BASE : MAG;
  const mouseY = useMotionValue(Infinity);
  const renderItem = (it: RailItem) => (
    <RailButton key={it.id} it={it} active={active === it.id} onSelect={onSelect} mouseY={mouseY} peak={peak} />
  );
  return (
    <div
      className="sidebar"
      onMouseMove={(e) => mouseY.set(e.pageY)}
      onMouseLeave={() => mouseY.set(Infinity)}
    >
      {TOP.map(renderItem)}
      <div className="sb-spacer" />
      {BOTTOM.map(renderItem)}
    </div>
  );
}
