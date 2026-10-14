import type { Client } from '../api.js';
import { callName, json, shortId } from '../format.js';
import { usePolling } from '../hooks.js';
import { href } from '../router.js';
import { describeChanges, type RunChanges } from '../../../engine/src/changes.js';
import type { RunComparison, RunCourse } from '../../../engine/src/compare.js';
import { Eyebrow, Stat } from './common.js';

export function CompareView({ client, a, b }: { client: Client; a: string; b: string }) {
  const { data: c, error } = usePolling(() => client.compare(a, b), `${a}:${b}`, null);
  if (error)
    return (
      <div className="page">
        <Eyebrow>compare</Eyebrow>
        <h1 className="display">Could not compare these runs.</h1>
        <p className="lede">{error.message}</p>
      </div>
    );
  if (!c) return <p className="note pad">Comparing…</p>;
  const identical = !c.firstRequestDifference && c.responseDifferences.length === 0 && c.onlyInA === 0 && c.onlyInB === 0;
  const f = c.firstRequestDifference;
  return (
    <div className="page scroll">
      <Eyebrow>
        compare · <a href={href.run(c.a.runId)}>{shortId(c.a.runId)}</a> with <a href={href.run(c.b.runId)}>{shortId(c.b.runId)}</a>
      </Eyebrow>
      <div className="page-title">
        <h1 className="display">{identical ? 'Identical runs.' : f ? `They part at call ${f.callNo}.` : 'Same requests, different answers.'}</h1>
        <a className="btn" href={href.compare(b, a)}>
          Swap
        </a>
      </div>
      <p className="lede">Calls pair by position until the first request differs; past that, each run stands alone. Meant for one agent: a recording and its replays and forks.</p>
      <ChangesLine changes={c.changes} />
      <div className="stats boxed">
        <Stat value={c.identicalPrefix} label="identical calls first" />
        <Stat value={f ? `#${f.callNo}` : '—'} label="first request that differs" />
        <Stat
          value={c.responseDifferences.length}
          label="answers differ"
          note={c.responseDifferences.length === 0 ? (c.identicalPrefix ? `all ${c.identicalPrefix} paired calls agreed` : 'no calls paired') : 'same request, before it'}
        />
        <Stat value={`${c.a.calls} / ${c.b.calls}`} label="calls in each" />
      </div>

      {f ? (
        <section className="block">
          <div className="fighd">
            <i>first difference</i> #{f.callNo} {f.kind} {f.name}
            <span className="r">
              <a href={href.run(c.a.runId, f.callNo)}>open in {shortId(c.a.runId)}</a> · <a href={href.run(c.b.runId, f.callNo)}>open in {shortId(c.b.runId)}</a>
            </span>
          </div>
          <div className="evidence">
            {!f.diff?.length ? <div className="ev-line muted">The stored requests are equal; they differ in what matching also reads: the headers that change model behavior, or values normalizers treat differently.</div> : null}
            {(f.diff ?? []).slice(0, 20).map((e, i) => (
              <div className="ev-diff" key={i}>
                <div className="ev-path">
                  <span className={`op op-${e.op}`}>{e.op === 'added' ? '+' : e.op === 'removed' ? '−' : '~'}</span> {e.path}
                </div>
                {e.op !== 'added' ? <pre className="del">− {json(e.before).slice(0, 1500)}</pre> : null}
                {e.op !== 'removed' ? <pre className="add">+ {json(e.after).slice(0, 1500)}</pre> : null}
              </div>
            ))}
            {(f.diff ?? []).some((e) => /\[\d+\]/.test(e.path)) ? (
              <div className="ev-line muted">Paths point into this call's request, so an index counts entries inside it — messages, tools — not calls in the run.</div>
            ) : null}
            {f.hints?.map((h, i) => (
              <div className="ev-line" key={i}>
                <span className="muted">hint:</span> {h.message}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {f && c.after ? <Courses c={c} from={f.callNo} /> : null}

      {c.responseDifferences.length ? (
        <section className="block">
          <div className="fighd">
            <i>same request, different answer</i> {c.responseDifferences.length} {c.responseDifferences.length === 1 ? 'call' : 'calls'}
          </div>
          <table className="calltable static">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Call</th>
                <th>What changed</th>
                <th className="num">Open in</th>
              </tr>
            </thead>
            <tbody>
              {c.responseDifferences.map((r) => (
                <tr key={r.callNo}>
                  <td className="num">{r.callNo}</td>
                  <td className="callname">
                    <span className="kind">{r.kind}</span>
                    <span className="name" title={r.name}>
                      {callName(r.kind, r.name)}
                    </span>
                  </td>
                  <td className="detail wrap">{r.detail}</td>
                  <td className="num">
                    <a href={href.run(c.a.runId, r.callNo)} title={`Open #${r.callNo} in ${shortId(c.a.runId)}`}>
                      {shortId(c.a.runId).slice(-4)}
                    </a>{' '}
                    ·{' '}
                    <a href={href.run(c.b.runId, r.callNo)} title={`Open #${r.callNo} in ${shortId(c.b.runId)}`}>
                      {shortId(c.b.runId).slice(-4)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {c.prefix.length ? <Prefix c={c} /> : null}
      {c.onlyInA || c.onlyInB ? (
        <p className="lede">
          {c.onlyInA ? `${shortId(c.a.runId)} continues for ${c.onlyInA} more ${c.onlyInA === 1 ? 'call' : 'calls'}.` : ''}
          {c.onlyInB ? ` ${shortId(c.b.runId)} continues for ${c.onlyInB} more ${c.onlyInB === 1 ? 'call' : 'calls'}.` : ''}
        </p>
      ) : null}
    </div>
  );
}

/** The calls that paired cleanly, so the headline number can be checked rather than believed. */
function Prefix({ c }: { c: RunComparison }) {
  const shown = c.prefix.slice(0, 50);
  return (
    <section className="block">
      <div className="fighd">
        <i>before that</i> {c.identicalPrefix} {c.identicalPrefix === 1 ? 'call' : 'calls'} matched on both the request and the answer
        {shown.length < c.identicalPrefix ? <span className="r muted">first {shown.length}</span> : null}
      </div>
      <table className="calltable static">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Call</th>
            <th className="num">Open in</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.callNo}>
              <td className="num">{r.callNo}</td>
              <td className="callname">
                <span className="kind">{r.kind}</span>
                <span className="name" title={r.name}>{callName(r.kind, r.name)}</span>
              </td>
              <td className="num">
                <a href={href.run(c.a.runId, r.callNo)} title={`Open #${r.callNo} in ${shortId(c.a.runId)}`}>{shortId(c.a.runId).slice(-4)}</a> ·{' '}
                <a href={href.run(c.b.runId, r.callNo)} title={`Open #${r.callNo} in ${shortId(c.b.runId)}`}>{shortId(c.b.runId).slice(-4)}</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** What differs between the two runs as a whole, before the call-by-call detail. */
function ChangesLine({ changes }: { changes: RunChanges }) {
  const items = describeChanges(changes);
  return (
    <p className="changes">
      <span className="label">What changed</span> {items.length ? items.join(' · ') : 'same system prompt, tools, models and code'}
    </p>
  );
}

/** After the first difference: what each run did on its own, side by side. */
function Courses({ c, from }: { c: RunComparison; from: number }) {
  const after = c.after!;
  // A fenced write is Shadowlap's doing, not the agent's: `send_email` and `send_email (blocked)` are
  // the same step taken, so they must not read as two different paths.
  const bare = (p: string[]) => p.map((s) => s.replace(/\s*\((?:blocked|stubbed|error)\)$/, '')).join('\n');
  const samePath = bare(after.a.path) === bare(after.b.path);
  const fenced = [...after.a.path, ...after.b.path].some((s) => /\((?:blocked|stubbed)\)$/.test(s));
  return (
    <section className="block">
      <div className="fighd">
        <i>from call {from} on</i> {samePath ? 'the same tools in the same turns' : 'different paths'}
      </div>
      {fenced ? (
        <p className="course-note">A step marked <b>blocked</b> or <b>stubbed</b> was reached by the agent and held back by the write fence, not changed by whatever made the runs part.</p>
      ) : null}
      <div className="courses">
        {([
          [c.a.runId, after.a],
          [c.b.runId, after.b],
        ] as Array<[string, RunCourse]>).map(([id, course]) => (
          <div className="course" key={id}>
            <div className="course-head">
              <a href={href.run(id, from)}>{shortId(id)}</a>
              <span className="muted">
                {course.calls} calls · {course.modelCalls} to the model
              </span>
            </div>
            <div className="course-path">
              {course.path.length ? course.path.map((step, i) => <span className={`chip${/\((blocked|stubbed|error)\)$/.test(step) ? ' is-error' : ''}`} key={i}>{step}</span>) : <span className="muted">no tool calls</span>}
            </div>
            {course.answer ? <p className="course-answer">{course.answer.length > 600 ? `${course.answer.slice(0, 599)}…` : course.answer}</p> : <p className="muted">no final answer</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
