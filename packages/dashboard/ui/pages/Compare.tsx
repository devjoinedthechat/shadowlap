import { useEffect, useMemo } from 'react';
import type { CallRow, CompareView, RunDetail, RunListItem } from '../api.js';
import { CmdLine, Org, PageHeader, Tag } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { answersSub, changedAnswers, changeCards, comparingLive, diffTexts, pickable, prefixLine, samePlaces } from '../compare/model.js';
import { RunPicker } from '../compare/RunPicker.js';
import { callName, clip, num, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { displayOrigin } from '../origins.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { defaultComparePair, isAttempt, runTag, type RunLike } from '../runs.js';
import { useApp } from '../state.js';

/**
 * Compare: what changed between two runs (code, system prompt, tools, model), then call by call: the
 * identical prefix, the first request that differs, where the paths went from there, and calls where
 * the same request got a different answer. With no runs named it opens the newest fork or replay
 * against its parent. A run still recording is compared again as its calls arrive.
 */
export function ComparePage({ a, b }: { a: string | null; b: string | null }) {
  const { runs, exported, meta } = useApp();
  const listed = useMemo(() => (runs ?? []).filter((r) => !isAttempt(r)), [runs]);
  // An exported copy of many runs holds only the pairs with its first run: it opens on one of those.
  const pair = a && b ? null : defaultComparePair(listed, exported ? (meta?.compareWith ?? null) : null);
  useEffect(() => {
    if (pair) navigate(href.compare(pair[0], pair[1]), true);
  }, [pair?.[0], pair?.[1]]);

  if (runs !== null && listed.length < 2)
    return (
      <Page>
        <PageHeader eyebrow="compare" title="What changed between two runs" />
        <section className="panel stepempty">
          <h3>Compare needs two runs</h3>
          <p>Replay or fork the run you have, and compare the two call by call.</p>
          <CmdLine>{`shadowlap replay ${listed[0] ? shortId(listed[0].runId) : '<run>'}`}</CmdLine>
        </section>
      </Page>
    );
  if (!a || !b) return <Page>{null}</Page>;
  return <Comparison key={`${a}:${b}`} a={a} b={b} runs={listed} />;
}

function Comparison({ a, b, runs }: { a: string; b: string; runs: RunListItem[] }) {
  const { client, live, tick, exported, meta } = useApp();
  // While either run records, each change to the store reads the comparison again; once both have ended, once more.
  const refresh = comparingLive(live, a, b) ? tick : 'ended';
  // The server's comparison, with the code card's commits when it can read the project's git (an exported copy has none).
  const cmp = useLoad<CompareView>(() => client.compare(a, b), `${a}:${b}`, refresh);
  const ra = useLoad(() => client.run(a), a, refresh);
  const rb = useLoad(() => client.run(b), b, refresh);
  const c = cmp.data;
  const hub = exported ? (meta?.compareWith ?? null) : null;
  const error = cmp.error
    ? cmp.error.message.includes('does not exist')
      ? 'One of these runs is not in the store.'
      : hub
        ? `This copy compares each run with ${shortId(hub)} only: pick it on one side.`
        : `Could not compare these runs: ${cmp.error.message}`
    : null;
  return (
    <Page>
      <PageHeader
        eyebrow="compare"
        title="What changed between two runs"
        text="What changed first, then call by call: the identical prefix, the first request that differs, and where the paths went from there."
        actions={<Pickers a={a} b={b} runs={runs} hub={hub} />}
      />
      {error ? <div className="empty">{error}</div> : null}
      {c ? (
        <>
          <Changes c={c} />
          <Prefix c={c} />
          {c.firstRequestDifference ? <FirstDifference c={c} /> : null}
          {ra.data && rb.data ? <Paths c={c} a={ra.data} b={rb.data} /> : null}
          <ResponseDifferences c={c} />
        </>
      ) : cmp.error ? null : (
        <div className="empty">Comparing…</div>
      )}
    </Page>
  );
}

function Pickers({ a, b, runs, hub }: { a: string; b: string; runs: RunListItem[]; hub: string | null }) {
  // Each side a run picker: the run's id, its about line fitted beside it, and the runs it can be compared with.
  const pick = (value: string, other: string, onChange: (v: string) => void, label: string) => {
    const options = pickable(runs, other, hub);
    const full = runs.find((x) => x.runId === value || x.runId.startsWith(value)) ?? null;
    const listed = full && !options.includes(full) ? [full, ...options] : options;
    return <RunPicker label={label} value={value} runs={listed} onPick={onChange} />;
  };
  return (
    <div className="pickers">
      {pick(a, b, (v) => navigate(href.compare(v, b)), 'Run A')}
      <span className="arrow" aria-hidden="true">
        →
      </span>
      {pick(b, a, (v) => navigate(href.compare(a, v)), 'Run B')}
      <a className="btn" href={href.compare(b, a)} title="Compare the other way round">
        Swap
      </a>
    </div>
  );
}

function Changes({ c }: { c: CompareView }) {
  return (
    <div className="changes">
      {changeCards(c).map((card) => (
        <div key={card.key} className={card.changed ? 'diff' : undefined} title={card.tip ?? undefined}>
          <span className="k">{card.key}</span>
          <b>{card.title}</b>
          <small>{card.note}</small>
        </div>
      ))}
    </div>
  );
}

function Prefix({ c }: { c: CompareView }) {
  const n = c.identicalPrefix;
  const cells = Math.max(1, Math.min(n, 120));
  const line = prefixLine(c);
  return (
    <div className="prefix">
      {/* Nothing identical: no bar, so the line has the row to itself. */}
      {n ? (
        <span className="ms" style={{ gridTemplateColumns: `repeat(${cells}, minmax(0, 1fr))` }} aria-hidden="true">
          {Array.from({ length: cells }, (_, i) => (
            <i key={i} className="rep" />
          ))}
        </span>
      ) : null}
      <span>
        <b>{line.lead}</b> {line.rest}
      </span>
    </div>
  );
}

/** How many differing fields the panel shows. */
const DIFF_SHOWN = 12;

function FirstDifference({ c }: { c: CompareView }) {
  const f = c.firstRequestDifference!;
  const diff = f.diff ?? [];
  const shown = diff.slice(0, DIFF_SHOWN);
  // Each field as the mock shows it: what it is (`tool_result lookup_policy`, its path on hover), then its value on each side.
  const side = (which: 'before' | 'after') =>
    shown.length
      ? shown.map((e, i) => {
          const value = diffTexts(e)[which];
          return (
            <span key={i}>
              <span title={e.what ? e.path : undefined}>{e.what ?? e.path}</span>
              {'\n'}
              {which === 'after' ? <span className="add">{value}</span> : `${value}\n`}
            </span>
          );
        })
      : `${f.kind} ${callName(f.kind, f.name)}`;
  const count = diff.length > 1 ? `${diff.length} fields differ${diff.length > DIFF_SHOWN ? `; the first ${DIFF_SHOWN} are shown` : ''}.` : null;
  const hints = f.hints ?? [];
  return (
    <section className="diffpanel boxed">
      <div>
        <h4>
          #{f.callNo} in <a href={href.run(c.a.runId, f.callNo)}>{shortId(c.a.runId)}</a>
        </h4>
        <pre>{side('before')}</pre>
      </div>
      <div>
        <h4>
          #{f.callNo} in <a href={href.run(c.b.runId, f.callNo)}>{shortId(c.b.runId)}</a>
        </h4>
        <pre>{side('after')}</pre>
      </div>
      {!diff.length || count || hints.length ? (
        <div className="hint">
          {!diff.length ? (
            'The stored requests are equal; they differ in what matching also reads: the headers that change model behaviour, or values normalizers treat differently.'
          ) : count ? (
            <span title="Hover a name for its path in this call’s request: an index counts entries inside it (messages, tools), not calls in the run.">{count}</span>
          ) : null}
          {hints.map((h, i) => (
            <span key={i} className="hline">
              {h.message}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function PathColumn({ run, calls, same, from, answer }: { run: RunDetail; calls: CallRow[]; same: boolean[]; from: number; answer: string | null | undefined }) {
  const tag = runTag({ ...(run.run as unknown as RunLike), calls: run.calls.length, divergence: run.run.divergence, mode: run.run.mode, status: run.run.status } as RunLike);
  const shown = calls.slice(0, 200);
  const recording = run.run.status === 'running';
  return (
    <div>
      <h4>
        <Tag cls={tag.cls}>{tag.text}</Tag>
        <a href={href.run(run.run.runId, from + 1)}>{shortId(run.run.runId)}</a> {from ? `after #${from}` : 'from #1'}
      </h4>
      {shown.map((c, i) => (
        <a key={c.callNo} className={`pcall${same[i] ? ' same' : ''}`} href={href.run(run.run.runId, c.callNo)} title={same[i] ? 'The other run made the same call here' : undefined}>
          <span className="pn">#{c.callNo}</span>
          <span>
            {callName(c.kind, c.name)}
            {c.input ? <span className="eff input">input</span> : c.effect ? <span className={`eff ${c.effect}`}>{c.effect}</span> : null}
          </span>
          <Org origin={displayOrigin(c)} />
        </a>
      ))}
      {calls.length > shown.length ? <div className="pcall more">… {num(calls.length - shown.length)} more calls</div> : null}
      {calls.length === 0 ? <div className="pcall more">{recording ? `no calls ${from ? `after #${from} ` : ''}yet` : `no calls after #${from}`}</div> : null}
      {recording ? <div className="pcall more">recording · more calls as they arrive</div> : answer ? <p className="pans">{clip(answer, 400)}</p> : null}
    </div>
  );
}

function Paths({ c, a, b }: { c: CompareView; a: RunDetail; b: RunDetail }) {
  const from = c.firstRequestDifference ? c.firstRequestDifference.callNo - 1 : c.identicalPrefix;
  const ca = a.calls.filter((x) => x.callNo > from);
  const cb = b.calls.filter((x) => x.callNo > from);
  const first = c.firstRequestDifference?.callNo ?? null;
  if (!ca.length && !cb.length && a.run.status !== 'running' && b.run.status !== 'running') return null;
  return (
    <div className="paths">
      <PathColumn run={a} calls={ca} same={samePlaces(ca, cb, first)} from={from} answer={c.after?.a.answer} />
      <PathColumn run={b} calls={cb} same={samePlaces(cb, ca, first)} from={from} answer={c.after?.b.answer} />
    </div>
  );
}

function ResponseDifferences({ c }: { c: CompareView }) {
  const first = c.firstRequestDifference?.callNo;
  // A call the model answered the same way in a new response is in the prefix line, not here.
  const rows = changedAnswers(c);
  if (!rows.length)
    return <p className="cmpnote">Same request, different response: none.{first ? ` The paths differ because the request at #${first} did.` : ''}</p>;
  return (
    <section className="panel cmpresp">
      <header>
        <h2>Same request, different answer</h2>
        <span className="sub">{answersSub(c)}</span>
      </header>
      <div className="tscroll">
        <table className="t">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Call</th>
              <th>What changed</th>
              <th className="num">Open in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.callNo} className="static">
                <td className="num">{r.callNo}</td>
                <td>{callName(r.kind, r.name)}</td>
                <td className="wrapcell">{r.detail}</td>
                <td className="num">
                  {/* Each run by its whole id: never a few characters of it. */}
                  <a href={href.run(c.a.runId, r.callNo)} title={`Open ${shortId(c.a.runId)} at #${r.callNo}`}>
                    <code className="rnm">{shortId(c.a.runId)}</code>
                  </a>{' '}
                  ·{' '}
                  <a href={href.run(c.b.runId, r.callNo)} title={`Open ${shortId(c.b.runId)} at #${r.callNo}`}>
                    <code className="rnm">{shortId(c.b.runId)}</code>
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
