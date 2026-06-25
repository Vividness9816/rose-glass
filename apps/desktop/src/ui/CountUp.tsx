/* Count Up (reactbits, motion-based): tweens from 0 on mount, then springs to each new value.
   Integer display. Reduced-motion shows the exact value with no tween. Used for the live
   statusbar metrics (notes / links / clusters), which actually change as the index updates. */

import { useEffect, useRef } from 'react';
import { useMotionValue, useSpring } from 'motion/react';
import { useReduceMotion } from '../appearance/useReduceMotion';

export function CountUp({ value, className }: { value: number; className?: string }) {
  const reduce = useReduceMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { mass: 0.8, stiffness: 70, damping: 18 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) {
      el.textContent = String(value); // no tween — land on the exact value
      return;
    }
    const unsub = spring.on('change', (v) => {
      el.textContent = String(Math.round(v));
    });
    mv.set(value); // mount: 0 → value; change: prev → value
    return unsub;
  }, [value, reduce, spring, mv]);

  // SSR/first paint text: the start (0) when animating, the exact value when reduced.
  return (
    <span ref={ref} className={className}>
      {reduce ? value : 0}
    </span>
  );
}
