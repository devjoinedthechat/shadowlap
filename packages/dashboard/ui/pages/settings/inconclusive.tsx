import type { ReactNode } from 'react';
import { Copy } from '../../components/Copy.js';
import { SegmentedControl } from '../../components/Segmented.js';
import { href } from '../../route.js';
import { useApp } from '../../state.js';
import type { CiWorkflowOptions } from '../../types.js';

/**
 * What an inconclusive golden does in CI, as the action's `inconclusive` input takes it: set on the
 * CI tab, in Your workflow, as every line Write file writes is, and said on Gates beside the odds of
 * an inconclusive verdict, where a link leads to the CI tab. Never set in two places.
 */

/** What each choice does; Fails writes no input, so the step does as `shadowlap test` does. */
const INCONCLUSIVE_WORDS: Record<'fail' | 'warn', ReactNode> = {
  fail: <>Fails the step, as a failed one does, but a gate against a history of fewer than 30 sessions only warns while the plan reads no decline or drop in them. Run more attempts can settle it.</>,
  warn: (
    <>
      Lets the step pass with a warning: <code>inconclusive: warn</code>. Every report still says inconclusive.
    </>
  ),
};
const INCONCLUSIVE_TOAST: Record<'fail' | 'warn', string> = {
  fail: 'An inconclusive golden fails the step, the default · a gate against fewer than 30 sessions only warns',
  warn: 'An inconclusive golden warns · Your workflow says inconclusive: warn',
};

/** The CI tab's row, in Your workflow: Fails or Warns, which changes what Write file would write. */
export function InconclusiveRow({ inc, set }: { inc: 'fail' | 'warn'; set: (patch: Partial<CiWorkflowOptions>) => void }) {
  const { toast } = useApp();
  return (
    <div className="setrow tight ciinc">
      <div>
        <b id="inconclusive-name">An inconclusive golden</b>
        <Copy as="span" id="inconclusive-help">
          {INCONCLUSIVE_WORDS[inc]}
        </Copy>
      </div>
      <SegmentedControl
        items={[
          { key: 'fail' as const, label: 'Fails' },
          { key: 'warn' as const, label: 'Warns' },
        ]}
        value={inc}
        labelledBy="inconclusive-name"
        describedBy="inconclusive-help"
        onChange={(k) => {
          if (k === inc) return;
          set({ inconclusive: k });
          toast(INCONCLUSIVE_TOAST[k]);
        }}
      />
    </div>
  );
}

/** Gates' line: what an inconclusive golden does in CI as Your workflow has it, and the way to where it is set. */
export function InconclusiveLine({ inc }: { inc: 'fail' | 'warn' }) {
  return (
    <div className="setrow tight ciinc">
      <div>
        <b>An inconclusive golden</b>
        <Copy as="span">{INCONCLUSIVE_WORDS[inc]}</Copy>
      </div>
      <a className="linkbtn" href={href.settings('ci')} title="What an inconclusive golden does in CI is set in Settings → CI, under Your workflow">
        Settings → CI
      </a>
    </div>
  );
}
