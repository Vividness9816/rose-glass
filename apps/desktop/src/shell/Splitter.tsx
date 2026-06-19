/* A draggable seam between two panes. One component, two orientations: axis 'x' is a
   vertical bar you drag left/right (col-resize), axis 'y' a horizontal bar you drag up/down
   (row-resize). During a drag it writes the container's CSS var IMPERATIVELY (no React
   re-render per pointermove — that would storm a large tree); it commits to state + session
   exactly once, on pointer-up. Pointer capture keeps the drag alive over the canvas/terminal.
   Keyboard-resize is a deliberate v2.1 gap (ADR-20260619); role=separator ships the a11y
   semantics now. The visible seam is the ::after hairline (terminal.css/shell.css). */

import { useRef, type RefObject, type PointerEvent as ReactPointerEvent } from 'react';
import './splitter.css';

interface SplitterProps {
  axis: 'x' | 'y';
  /** Element whose bounding rect defines the drag axis and whose CSS var we drive. */
  containerRef: RefObject<HTMLElement | null>;
  /** CSS custom property to update (e.g. '--rg-split' or '--rg-term-h'). */
  varName: string;
  /** Pointer client position (clientX for 'x', clientY for 'y') + the container rect → value. */
  compute: (clientPos: number, rect: DOMRect) => number;
  /** Value → CSS var string (e.g. fraction → '0.6', px → '320px'). */
  format: (v: number) => string;
  /** Persist + setState on drag end (called once). */
  onCommit: (v: number) => void;
  ariaLabel: string;
}

export function Splitter({ axis, containerRef, varName, compute, format, onCommit, ariaLabel }: SplitterProps) {
  const draggingRef = useRef(false);
  const latestRef = useRef<number | null>(null);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!containerRef.current) return;
    e.preventDefault();
    draggingRef.current = true;
    latestRef.current = null;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // Hold the resize cursor + suppress selection for the whole drag, even over other panes.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!draggingRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const v = compute(axis === 'x' ? e.clientX : e.clientY, rect);
    latestRef.current = v;
    el.style.setProperty(varName, format(v)); // imperative — no re-render mid-drag
  };

  const end = (e: ReactPointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    if (latestRef.current !== null) onCommit(latestRef.current); // commit once → setState + persist
  };

  return (
    <div
      className={`splitter splitter-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}
