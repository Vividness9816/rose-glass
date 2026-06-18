/* v2.0 — the expandable graph-settings panel (top-right of the graph). Collapsed to a
   gear; expanded it tunes the SHARED physics (so both renderers react) + per-cluster
   colors + free/fixed mode. Pure presentational: state + persistence live in GraphPane. */

import { useState } from 'react';
import { DEFAULT_CONFIG, type GraphConfig } from './config';

type SliderKey = 'gravity' | 'repulsion' | 'drift' | 'damping';
const SLIDERS: { key: SliderKey; label: string; min: number; max: number; step: number; hint: string }[] = [
  { key: 'gravity', label: 'gravity', min: 0, max: 0.02, step: 0.001, hint: 'pull toward cluster centre' },
  { key: 'repulsion', label: 'strength', min: 0, max: 0.4, step: 0.01, hint: 'how hard nodes push apart' },
  { key: 'drift', label: 'movement', min: 0, max: 0.2, step: 0.005, hint: 'idle wander amplitude' },
  { key: 'damping', label: 'liveliness', min: 0.5, max: 0.97, step: 0.01, hint: 'higher = looser, lower settles faster' },
];

/** Resolve the theme's current --cluster-N to a #rrggbb so the swatch shows the live
    default when there's no user override. */
function clusterColorHex(i: number): string {
  if (typeof document === 'undefined') return '#888888';
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;opacity:0;pointer-events:none';
  probe.style.color = `var(--cluster-${i})`;
  document.body.appendChild(probe);
  const m = getComputedStyle(probe).color.match(/\d+/g);
  document.body.removeChild(probe);
  if (!m || m.length < 3) return '#888888';
  const h = (n: string) => Number(n).toString(16).padStart(2, '0');
  return `#${h(m[0])}${h(m[1])}${h(m[2])}`;
}

export function GraphConfigPanel({
  config,
  onChange,
}: {
  config: GraphConfig;
  onChange: (c: GraphConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof GraphConfig>(k: K, v: GraphConfig[K]) => onChange({ ...config, [k]: v });
  const setColor = (i: number, v: string) => {
    const next = [...config.clusterColors] as GraphConfig['clusterColors'];
    next[i] = v;
    set('clusterColors', next);
  };

  if (!open) {
    return (
      <button
        className="gcfg-gear"
        type="button"
        onClick={() => setOpen(true)}
        title="Graph settings"
        aria-label="Graph settings"
      >
        ⚙
      </button>
    );
  }

  return (
    <div className="gcfg-panel" role="dialog" aria-label="Graph settings">
      <div className="gcfg-head">
        <span>graph physics</span>
        <button className="gcfg-x" type="button" onClick={() => setOpen(false)} aria-label="Close settings">
          ×
        </button>
      </div>

      <div className="gcfg-modes">
        {(['free', 'fixed'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`gc-btn${config.mode === m ? ' active' : ''}`}
            onClick={() => set('mode', m)}
            aria-pressed={config.mode === m}
            title={m === 'free' ? 'Nodes drift continuously' : 'Nodes settle into place and hold (still draggable)'}
          >
            {m === 'free' ? 'Free-float' : 'Fixed'}
          </button>
        ))}
      </div>

      {SLIDERS.map((s) => (
        <label key={s.key} className="gcfg-row" title={s.hint}>
          <span className="gcfg-label">{s.label}</span>
          <input
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            value={config[s.key]}
            disabled={s.key === 'drift' && config.mode === 'fixed'}
            onChange={(e) => set(s.key, Number(e.target.value))}
          />
        </label>
      ))}

      <div className="gcfg-row">
        <span className="gcfg-label">colors</span>
        <div className="gcfg-swatches">
          {[0, 1, 2, 3].map((i) => (
            <input
              key={i}
              type="color"
              className="gcfg-swatch"
              value={config.clusterColors[i] || clusterColorHex(i)}
              title={`cluster ${i}${config.clusterColors[i] ? '' : ' (theme default)'}`}
              onChange={(e) => setColor(i, e.target.value)}
            />
          ))}
        </div>
      </div>

      <button className="gc-btn gcfg-reset" type="button" onClick={() => onChange({ ...DEFAULT_CONFIG })}>
        Reset
      </button>
    </div>
  );
}
