/* Split Text (reactbits, motion-based): reveals a string per word with a stagger on mount.
   Accessible — the whole string is the aria-label; the per-word spans are aria-hidden, so a
   screen reader reads the title once, not letter-by-letter. Reduced-motion renders plain text.
   Replay-on-change is the caller's job: key the element (e.g. by note path) so opening a note
   remounts it and the reveal plays again. */

import { motion, useReducedMotion } from 'motion/react';

export function SplitText({ text, className }: { text: string; className?: string }) {
  const reduce = useReducedMotion();
  if (reduce) return <span className={className}>{text}</span>;

  // Split on whitespace but KEEP the separators (the capture group) so spacing survives exactly.
  const parts = text.split(/(\s+)/);
  return (
    <span className={className} aria-label={text}>
      {parts.map((p, i) => (
        <motion.span
          key={i}
          aria-hidden="true"
          style={{ display: 'inline-block', whiteSpace: 'pre' }}
          initial={{ opacity: 0, y: '0.4em' }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.035, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          {p}
        </motion.span>
      ))}
    </span>
  );
}
