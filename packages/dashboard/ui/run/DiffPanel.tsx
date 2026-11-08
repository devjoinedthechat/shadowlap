import type { ReactNode } from 'react';
import type { RunDetail } from '../api.js';
import { CmdLine } from '../components/bits.js';
import { callName, clip, jsonText, shortId } from '../format.js';
import type { TestBannerOffer } from '../types.js';
import { DIVERGED } from './banner.js';
import { updatesAfterRules } from './offers.js';

/**
 * A fork's or a diverged test's diff, which shows in the inspector's place once its finding's Show diff
 * is pressed (InspectorPanel.tsx): a part of its own, loaded the first time it shows, so the run page
 * keeps within its budget.
 */

/** A one-line JSON value with a place to break after each comma, for a pane that wraps it (a narrow window's). */
function breakable(text: string): ReactNode[] {
  const parts = text.split(',');
  return parts.flatMap((part, i) => (i < parts.length - 1 ? [`${part},`, <wbr key={i} />] : [part]));
}

/**
 * What a diverged test's banner found, said again under the diff: the value made anew on every run,
 * what it looks like, and what its normalizer does; that one the recording never had needs the
 * golden updated after the rule, and that one that may be a real change should be looked at first.
 */
function VolatileHint({ v, updates }: { v: NonNullable<TestBannerOffer['volatile']>; updates: boolean }) {
  return (
    <span>
      {' '}
      {v.op === 'added' ? (
        <>
          A value the recording never had, at <code>{v.path}</code>, looks like {v.looks}
        </>
      ) : (
        <>
          Only a value changed at <code>{v.path}</code>, and it looks like {v.looks}
        </>
      )}
      {v.certain ? ': the agent makes a new one on every run.' : ', though it may be a real change: look at it before masking it.'} A normalizer masks it before matching
      {updates ? '; the request still carries the field the recording lacks, so the golden is updated after it.' : ', and older recordings match too.'}
    </span>
  );
}

type Normalizer = NonNullable<NonNullable<NonNullable<RunDetail['run']['divergence']>['hints']>[number]['normalizer']>;

/** The command that adds the normalizer a divergence's hint suggests. */
function normalizerCommand(n: Normalizer): string {
  return `shadowlap normalize add${n.kind ? ` --kind ${n.kind}` : ''}${n.name ? ` --name ${n.name}` : ''} --path '${n.path ?? '$'}'${n.pattern ? ` --pattern ${n.pattern}` : ''} --replace '${n.replace}'`;
}

/**
 * The request that changed at the fork: what the recording sent, and what this run sent. A diverged
 * test's value made anew on every run is the test offer's finding (the banner's), judged on all its
 * changes: the panel says so, with its normalizer, and says none is suggested only when neither the
 * divergence's hints nor the finding suggest one.
 */
export function DiffPanel({ run, test = null }: { run: RunDetail; test?: TestBannerOffer | null }) {
  const d = run.run.divergence;
  if (!d) return null;
  const diff = d.diff ?? [];
  const parent = run.parent ? shortId(run.parent.runId) : 'the recording';
  const hint = d.hints?.find((h) => h.normalizer);
  const n = hint?.normalizer;
  const v = test?.volatile ?? null;
  const command = v?.command ?? (n ? normalizerCommand(n) : null);
  return (
    <section className="diffpanel">
      <div>
        <h4>
          Recorded request #{d.counterpart?.callNo ?? d.callNo} · {parent}
        </h4>
        <pre>
          {diff.length
            ? diff.slice(0, 12).map((e, i) => (
                <span key={i}>
                  {e.path}
                  <span className="val">{e.op === 'added' ? '  (absent)' : <>{'  '}{breakable(clip(jsonText(e.before, false), 800))}</>}</span>
                </span>
              ))
            : (d.reason ?? DIVERGED[d.type] ?? d.type)}
        </pre>
      </div>
      <div>
        <h4>This run’s request #{d.callNo}</h4>
        <pre>
          {diff.length
            ? diff.slice(0, 12).map((e, i) => (
                <span key={i}>
                  {e.path}
                  <span className="add">{e.op === 'removed' ? '  (absent)' : <>{'  '}{breakable(clip(jsonText(e.after, false), 800))}</>}</span>
                </span>
              ))
            : callName(d.kind, d.name)}
        </pre>
      </div>
      <div className="hint">
        {diff.length ? `${diff.length === 1 ? 'One field' : `${diff.length} fields`} changed${diff.length > 12 ? '; the first 12 are shown' : ''}.` : null}
        {v ? (
          <VolatileHint v={v} updates={!!test && updatesAfterRules(test)} />
        ) : (
          d.hints?.map((h, i) => <span key={i}> {h.message}</span>)
        )}
        {!hint && !v && diff.length ? ' Not a date or an id, so no normalizer is suggested.' : null}
        {command ? <CmdLine>{command}</CmdLine> : null}
      </div>
    </section>
  );
}
