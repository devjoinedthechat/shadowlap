import { Fragment, type ReactNode } from 'react';
import type { Matrix } from '../matrix.js';
import { closePanelOn, openResults, usePanel } from '../run/panel-state.js';
import { LoadFailed } from './bits.js';
import { Command } from './Copy.js';
import { DotParts } from './DotParts.js';
import { onShow } from './OnShow.js';
import { Receipt, type ReceiptLine } from './Receipt.js';
import type { MatrixHeads, MatrixKeys } from './ResultsMatrix.js';
import { Skeleton } from './States.js';

/**
 * What a finding's Show results opens in the inspector's place (run/InspectorPanel.tsx), one design
 * for an injection test and the error-path presets: the matrix's name in the UI face, what was tried,
 * where and when, and the command at the right (under them on a phone); the matrix with its key in
 * its head, or a sentence where no attempt ran; the rule and the checks on one line under it (a line
 * each on a phone); and a quiet receipt at its foot, under a hairline.
 */

/** What shows in the matrix's place while its script comes, and once it failed to come. */
export const MATRIX_STATES = { waiting: <Skeleton what="the results" lines={4} />, failed: <LoadFailed what="matrix" /> };

/**
 * The results matrix, a part of its own: its script loads the first time it shows, or as the pointer
 * or the focus reaches Show results. Exported for Tests, which draws a golden's presets through it.
 */
export const ResultsMatrixPart = onShow(() => import('./ResultsMatrix.js').then((m) => m.ResultsMatrix), MATRIX_STATES);

export interface FindingPanelProps {
  /** What it holds: `injection`, `presets`. */
  kind: string;
  /** Its accessible name: "Injection test results". */
  name: string;
  /** The matrix's name in its head: "Untrusted reads × payloads". */
  label: string;
  /** How many it tried, what, where and when: ["72 attempts", "12 templates, version 1", "Oct 1, 09:31"]. */
  meta: readonly string[];
  /** The command that ran it, with no `$`. */
  cmd: string;
  /** Null where no attempt ran: `none` says why, and there is no key. */
  matrix: Matrix | null;
  none?: string | null | undefined;
  keys?: MatrixKeys | null | undefined;
  heads?: MatrixHeads | undefined;
  /** What decided it: the gate's rule (`RuleText`), the checks, each part a node that may carry a card. */
  line?: readonly ReactNode[] | undefined;
  receipt: readonly ReceiptLine[];
}

/** A line of parts, the dot kept with the part before it, so no line starts with one; a line each on a phone. */
function PartsLine({ parts }: { parts: readonly ReactNode[] }) {
  return (
    <p className="rmxp-line">
      {parts.map((x, i) => (
        <Fragment key={i}>
          {i ? ' ' : null}
          <span className="rmxl">
            {x}
            {i < parts.length - 1 ? <span className="rmxsep">{'\u00a0·'}</span> : null}
          </span>
        </Fragment>
      ))}
    </p>
  );
}

export function FindingPanel({ kind, name, label, meta, cmd, matrix, none, keys, heads, line, receipt }: FindingPanelProps) {
  const parts = (line ?? []).filter((x) => x !== null && x !== undefined && x !== false && x !== '');
  return (
    <section className="rmxp" data-kind={kind} aria-label={name}>
      <div className="rmxp-h">
        <span className="rmxp-t">{label}</span>
        <span className="rmxp-meta">
          <DotParts parts={meta} />
        </span>
        <span className="rmxp-cmd">
          <Command cmd={cmd} inline prompt={false} />
        </span>
      </div>
      {matrix ? <ResultsMatrixPart matrix={matrix} keys={keys ?? null} heads={heads} /> : <p className="rmxp-none">{none}</p>}
      {parts.length ? <PartsLine parts={parts} /> : null}
      <Receipt lines={receipt} />
    </section>
  );
}

/**
 * A finding's Show results, Hide results once they are open: they take the inspector's place on the
 * run's page (`which` names them there: `injection:<result id>`, `presets`), and the focus stays on it.
 * Its matrix's script loads as the pointer or the focus reaches it, so it shows at once.
 */
export function ResultsToggle({ runId, which }: { runId: string; which: string }) {
  const panel = usePanel(runId);
  const open = panel?.kind === 'results' && panel.key === which;
  const preload = () => ResultsMatrixPart.preload();
  return (
    <button className="linkbtn" type="button" data-act="results" data-which={which} aria-expanded={open} aria-controls="insp" onPointerEnter={preload} onFocus={preload} onClick={() => (open ? closePanelOn(runId) : openResults(runId, which))}>
      {open ? 'Hide results' : 'Show results'}
    </button>
  );
}
