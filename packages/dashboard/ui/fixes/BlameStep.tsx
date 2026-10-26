import { Badge, CmdLine, EmptyState, Pips } from '../components/bits.js';
import { rowOpen } from '../components/Table.js';
import { approx, num, shortId } from '../format.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import type { BlameStep, FixDetail } from '../types.js';
import { attemptMark, blameWhere, callRowCells, probeBadge, probeVerdictWords } from './model.js';
import { AttemptGroups, useAttemptGroups } from './AttemptGroups.js';
import { StepHead } from './parts.js';

/**
 * The Blame step: where the run was lost (the probed calls on the run's row of calls), the answers
 * on both sides, the probes and their attempts, and what finding out took.
 */
export function BlameStepView({ fix }: { fix: FixDetail }) {
  const groups = useAttemptGroups(fix.fixId);
  const b = fix.blame;
  // A fix starts from a blame, so this only shows for a fix whose blame was deleted from the store.
  if (!b) return <EmptyState title="Not blamed yet" text="blame finds the model call where a failed run was lost: the last one whose answer, asked again, lets the run pass." command={fix.commands.blame} />;
  const where = blameWhere(b);
  const others = fix.blames.filter((x) => x.blameId !== b.blameId);
  // What blame's JSON says beyond its probes, when it says it: the calls it lost the run between, and the error bound its confidence comes from.
  const range = b.evidence?.range ?? null;
  const errorBound = b.evidence?.errorBound ?? null;
  const probeGroups = (callNo: number) => (groups?.blame?.blameId === b.blameId ? (groups.blame.probes.find((p) => p.callNo === callNo) ?? null) : null);
  return (
    <>
      <StepHead
        title={b.title}
        text={
          <>
            {where ? `${where} of ` : 'Run '}
            <a className="more" href={b.hrefs.run}>
              {shortId(b.runId)}
            </a>
            {` · confidence ${b.confidence}${errorBound !== null ? ` (error ≤ ${errorBound})` : ''}`}
            {range && range.from !== range.to ? ` · lost between #${range.from} and #${range.to}` : null}
            <span className="pline" title={b.confidenceWhy}>
              {b.boundary}
            </span>
          </>
        }
        actions={
          <>
            {b.hrefs.lostAt ? (
              <a className="btn" href={b.hrefs.lostAt}>
                Open the run at #{b.lostAt}
              </a>
            ) : b.runExists ? (
              <a className="btn" href={b.hrefs.run}>
                Open the run
              </a>
            ) : null}
            {b.hrefs.rescued ? (
              <a className="btn" href={b.hrefs.rescued}>
                Open the rescued fork
              </a>
            ) : null}
          </>
        }
      />
      <div className="grid2">
        <section className="panel">
          <header>
            {/* Where the run was lost only once blame named the call: otherwise these are the run's calls, with what each probe found. */}
            <h2>{b.outcome === 'blamed' ? 'Where the run was lost' : 'The run’s calls'}</h2>
            <span className="sub">each probe re-asks one model call; everything before it replays free</span>
          </header>
          <div className="pbody">
            <CallRow b={b} />
          </div>
        </section>
        {b.answers ? <Answers b={b} /> : <Checked b={b} />}
      </div>
      {b.probes.length ? (
        <section className="panel fxgap">
          <header>
            <h2>Probes</h2>
            <span className="sub">
              {b.rule}
              {b.rescue !== 'resample the probed call' ? ` · ${b.rescue}` : ''}
            </span>
          </header>
          <div className="tscroll">
            <table className="t probes">
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Model call</th>
                  <th>Attempts</th>
                  <th>Passed</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {b.probes.map((p) => (
                  <tr key={p.callNo} className={p.blamed ? 'hot' : undefined} onClick={rowOpen(() => navigate(p.href))}>
                    <td>
                      <a className="fxcall" href={p.href}>
                        <code>#{p.callNo}</code>
                      </a>
                    </td>
                    <td>
                      {p.step} of {b.steps}
                    </td>
                    <td>
                      <Pips ok={p.passes} unsure={p.inconclusive} no={p.attempts - p.passes - p.inconclusive} />
                    </td>
                    <td className="num left">
                      {p.passes} of {p.attempts - p.inconclusive}
                      {p.inconclusive ? <span className="fxdim"> · {p.inconclusive} not judged</span> : null}
                      {p.bound ? (
                        <span className="fxdim" title={p.gate?.method ? `the bound: ${p.gate.method}` : undefined}>
                          {' '}
                          · {p.bound}
                        </span>
                      ) : null}
                      {p.gate?.unavailable ? <span className="fxdim"> · {p.gate.unavailable} unavailable</span> : null}
                    </td>
                    <td>
                      <Badge tone={probeBadge(p.verdict)}>{probeVerdictWords(p.verdict).word}</Badge>
                      {probeVerdictWords(p.verdict).blamed ? <b className="bmk">blamed</b> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <div className="grid2 fxgap">
        <section className="panel">
          <header>
            <h2>Attempts</h2>
            <span className="sub">runs in the store, bundled per probe</span>
          </header>
          <div className="pbody">
            {b.bundles.length ? (
              b.bundles.map((x) => (
                <div key={x.callNo} className="fxbundle">
                  <span className="k">{x.title}</span>
                  {probeGroups(x.callNo) ? <AttemptGroups groups={probeGroups(x.callNo)!.groups} attempts={probeGroups(x.callNo)!.attempts} label={`probe #${x.callNo}`} /> : null}
                  <div className="attempts">
                    {x.attempts.map((a) => (
                      <a key={a.runId} href={a.href} title={`${shortId(a.runId)} · ${a.note}`}>
                        <i className={attemptMark(a)} />
                        <span className="t">
                          {shortId(a.runId)} · {a.note}
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <p className="fxnote">No attempt ran: {b.stopReason ?? 'the search stopped before its first probe'}.</p>
            )}
            {others.length ? (
              <p className="fxnote">
                Also blamed:{' '}
                {others.map((o, i) => (
                  <span key={o.blameId}>
                    {i ? ', ' : ''}
                    <a className="more" href={href.run(o.runId, o.lostAt)}>
                      {shortId(o.runId)}
                    </a>{' '}
                    {o.outcome === 'blamed' && o.lostAt !== null ? `lost at #${o.lostAt}` : o.outcome === 'unrescuable' ? (o.unsettled ? 'not settled' : 'not rescued') : 'stopped'}
                  </span>
                ))}
                .
              </p>
            ) : null}
          </div>
        </section>
        <section className="panel">
          <header>
            <h2>Cost</h2>
          </header>
          <div className="pbody">
            <div className="trio">
              <div>
                <span className="k">attempts</span>
                <b>{num(b.cost.attempts)}</b>
              </div>
              <div>
                <span className="k">upstream</span>
                <b>{num(b.cost.upstreamRequests)}</b>
              </div>
              <div>
                <span className="k">spent</span>
                <b>{approx(b.cost.spent)}</b>
              </div>
            </div>
            <p className="fxnote">
              Every call before a probe was replayed from the recording.
              {b.cost.unknownModels.length ? ` No price for ${b.cost.unknownModels.join(', ')}, so its calls count as $0.` : ''}
            </p>
            {b.pulled ? <p className="fxnote">It ran on a teammate’s machine and came with a pull. The command here is made from its report, without what ran only there.</p> : null}
            <div className="fxcmd">
              <CmdLine>{b.command}</CmdLine>
            </div>
          </div>
        </section>
      </div>
      {b.warnings.length ? (
        <ul className="fxwarn">
          {b.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function CallRow({ b }: { b: BlameStep }) {
  if (!b.callRow.length) return <p className="fxnote">The run is no longer in the store.</p>;
  const { cells, toolsLeftOut } = callRowCells(b.callRow);
  return (
    <>
      <ol className="callrow fxrow">
        {cells.map((c) => {
          if (c.kind === 'gap')
            return (
              <li key={c.callNo} className="gap" title={`${c.skipped!} calls left out`}>
                <span className="pp" />
                <span className="pl" />
                <span className="nr">…</span>
                <span className="cl" />
              </li>
            );
          const tone = c.verdict === 'blamed' ? 'hot' : c.verdict === 'lost' ? 'lost' : c.verdict === 'inconclusive' ? 'unsure' : c.verdict === 'rescued' ? 'ok' : '';
          return (
            <li key={c.callNo} className={`${c.kind}${tone ? ` ${tone}` : ''}${c.dim ? ' dim' : ''}`}>
              <span className="pp">{c.verdict ? <Pips ok={c.passes} unsure={c.inconclusive} no={c.attempts - c.passes - c.inconclusive} /> : null}</span>
              <span className="pl">{c.verdict ?? ''}</span>
              <span className="nr">
                <a className="cn" href={href.run(b.runId, c.callNo)} aria-label={`Call #${c.callNo}`} />
              </span>
              <span className="cl">#{c.callNo}</span>
            </li>
          );
        })}
      </ol>
      <div className="legend fxlegend">
        <span>
          <i className="lg rep" />
          attempt passed
        </span>
        <span>
          <i className="lg block" />
          attempt failed
        </span>
        {b.callRow.some((c) => c.inconclusive) ? (
          <span>
            <i className="lg unsure" />
            attempt not judged
          </span>
        ) : null}
        <span>{toolsLeftOut ? 'model calls only' : 'ring: model call · dot: tool call'}</span>
        {b.scope ? <span>dimmed: outside scope {b.scope}</span> : null}
      </div>
    </>
  );
}

function Answers({ b }: { b: BlameStep }) {
  const a = b.answers!;
  return (
    <section className="panel">
      <header>
        <h2>At call #{a.callNo}</h2>
      </header>
      <div className="pbody">
        <div className="ans one">
          <div>
            <span className="k">the recording</span>
            <code>{a.recorded || '(no answer)'}</code>
          </div>
          <div className="good">
            <span className="k">
              a rescued fork
              {b.rescuedRunId ? (
                <>
                  {' · '}
                  <a className="more" href={href.run(b.rescuedRunId)}>
                    {shortId(b.rescuedRunId)}
                  </a>
                </>
              ) : null}
            </span>
            <code>{a.rescued || '(no answer)'}</code>
          </div>
        </div>
        {b.pairs ? (
          <p className="pairnote">
            Both answers saw the same conversation, so they make a training pair.{' '}
            <a className="more" href={href.training()}>
              {b.pairs} pair{b.pairs === 1 ? '' : 's'} in Training
            </a>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** For a blame that placed the failure on no call: what it checked, and how the recording failed it. */
function Checked({ b }: { b: BlameStep }) {
  return (
    <section className="panel">
      <header>
        <h2>The check</h2>
        <span className="sub">what a passing run must do</span>
      </header>
      <div className="pbody">
        <ul className="fxlist">
          {b.oracle.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
        {b.recordedFailures.length ? (
          <>
            <span className="k">as recorded</span>
            <ul className="fxlist bad">
              {b.recordedFailures.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="fxnote">{b.outcome === 'unrescuable' ? (b.look ?? 'Asking any model call again did not let the run pass often enough: the cause may be before the first model call, in a tool, or in the check itself.') : `The search stopped: ${b.stopReason ?? 'before it was done'}. Blame it again to finish.`}</p>
      </div>
    </section>
  );
}
