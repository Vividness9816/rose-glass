/* Editor pane — static mockup content ported 1:1 (mockup .editor-pane).
   The real CodeMirror 6 editor with live decorations lands in Phase 3;
   this increment proves the pane's visual contract. */

export function EditorPane() {
  return (
    <div className="editor-pane">
      <div className="editor-header">
        <div className="breadcrumb">
          <span className="bc-seg">research-notes</span>
          <span className="bc-sep">›</span>
          <span className="bc-seg">neuroscience</span>
          <span className="bc-sep">›</span>
          <span className="bc-current">synaptic pruning</span>
        </div>
        <div className="editor-actions">
          <button className="ea-btn" title="Outline" type="button">≡</button>
          <button className="ea-btn" title="Properties" type="button">◈</button>
          <button className="ea-btn" title="Share" type="button">↗</button>
        </div>
      </div>

      <div className="editor-body selectable">
        <div className="note-title">Synaptic pruning</div>
        <div className="note-meta">
          <span>📅 Jun 12 2026</span>
          <span>⟳ 2 days ago</span>
          <span>◈ 847 words</span>
          <span>↙ 4 backlinks</span>
        </div>

        <div className="note-body">
          <p>
            <span className="tag">#neuroscience</span> <span className="tag">#development</span>
          </p>
          <p>
            Synaptic pruning is the process by which extra neurons and synaptic connections are
            eliminated in order to increase the efficiency of neuronal transmissions. The process
            begins in the 2nd trimester of fetal development and continues into early adulthood.
          </p>
          <p>
            The <span className="wikilink">[[prefrontal cortex]]</span> undergoes significant
            pruning during adolescence, which may explain why risk assessment and impulse control
            are still developing into the mid-20s. This connects directly to work on{' '}
            <span className="wikilink">[[neural plasticity]]</span> and the{' '}
            <span className="wikilink">[[critical period hypothesis]]</span>.
          </p>
          <h2>Mechanisms</h2>
          <p>
            Microglia actively engulf synapses tagged with complement proteins C1q and C3, in a
            process called <span className="inline-code">complement-mediated pruning</span>. This is
            activity-dependent — synapses that fire together, survive together.
          </p>
          <p>
            Recent work on <span className="wikilink">[[long-term potentiation]]</span> suggests
            that pruning is not passive decay but an active sculpting process. See{' '}
            <span className="wikilink">[[Hebb's rule]]</span> for the foundational theory.
          </p>
          <h2>Clinical relevance</h2>
          <p>
            Dysregulation has been implicated in{' '}
            <span className="wikilink">[[schizophrenia]]</span> (excess pruning) and{' '}
            <span className="wikilink">[[autism spectrum disorder]]</span> (insufficient pruning).
            The <span className="inline-code">C4A</span> gene variant is a key risk factor.
          </p>
          <p className="cursor-line">This may also intersect with findings from</p>
        </div>

        <div className="backlinks">
          <div className="bl-label">Backlinks · 4</div>
          <div className="bl-item">
            <div className="bl-dot" />
            <div>
              <div className="bl-title">Neural plasticity</div>
              <div className="bl-excerpt">
                ...synaptic pruning refines the circuits established during the critical period,
                eliminating redundant pathways...
              </div>
            </div>
          </div>
          <div className="bl-item">
            <div className="bl-dot bl-dot-violet" />
            <div>
              <div className="bl-title">Schizophrenia — etiology overview</div>
              <div className="bl-excerpt">
                ...excess synaptic pruning during adolescent development, mediated by complement
                cascade dysregulation...
              </div>
            </div>
          </div>
          <div className="bl-item">
            <div className="bl-dot bl-dot-violet" />
            <div>
              <div className="bl-title">Adolescent brain development</div>
              <div className="bl-excerpt">
                ...the prefrontal cortex is among the last regions to complete synaptic pruning,
                explaining delayed...
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
