import { useEffect, useMemo } from 'react';
import type { CallRow, RunComparison, RunDetail, RunListItem } from '../api.js';
import { CmdLine, Org, PageHeader, Tag } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { Page } from '../components/Page.js';
import { callName, clip, jsonText, num, shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { displayOrigin } from '../origins.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { defaultComparePair, isAttempt, kindWord, runTag, type RunLike } from '../runs.js';
import { useApp } from '../state.js';

/**
 * Compare: what changed between two runs (code, system prompt, tools, model), then call by call: the
 * identical prefix, the first request that differs, where the paths went from there, and calls where
 * the same request got a different answer. With no runs named it opens the newest fork or replay
 * against its parent.
 */
export function ComparePage({ a, b }: { a: string | null; b: string | null }) {
  const { runs } = useApp();
  const listed = useMemo(() => (runs ?? []).filter((r) => !isAttempt(r)), [runs]);
  const pair = a && b ? null : defaultComparePair(listed);
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
  const { client } = useApp();
  const cmp = useLoad(() => client.compare(a, b), `${a}:${b}`);
  const ra = useLoad(() => client.run(a), a);
  const rb = useLoad(() => client.run(b), b);
  const c = cmp.data;
  return (
    <Page>
      <PageHeader
        eyebrow="compare"
        title="What changed between two runs"
        text="What changed first, then call by call: the identical prefix, the first request that differs, and where the paths went from there."
        actions={<Pickers a={a} b={b} runs={runs} />}
      />
      {cmp.error ? <div className="empty">{cmp.error.message.includes('does not exist') ? 'One of these runs is not in the store.' : `Could not compare these runs: ${cmp.error.message}`}</div> : null}
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

function Pickers({ a, b, runs }: { a: string; b: string; runs: RunListItem[] }) {
  const options = useMemo(() => [...runs].sort((x, y) => y.startedAt - x.startedAt).slice(0, 300), [runs]);
  const option = (id: string) => {
    const r = runs.find((x) => x.runId === id || x.runId.startsWith(id));
    return r ? r.runId : id;
  };
  const pick = (value: string, onChange: (v: string) => void, label: string) => (
    <span className="pick">
      <select aria-label={label} value={option(value)} onChange={(e) => onChange(e.target.value)}>
        {options.some((r) => r.runId === option(value)) ? null : <option value={option(value)}>{shortId(value)}</option>}
        {options.map((r) => (
          <option key={r.runId} value={r.runId}>
            {shortId(r.runId)} · {kindWord(r)}
          </option>
        ))}
      </select>
      <Icon name="caret" className="caret" />
    </span>
  );
  return (
    <div className="pickers">
      {pick(a, (v) => navigate(href.compare(v, b)), 'Run A')}
      <span className="arrow" aria-hidden="true">
        →
      </span>
      {pick(b, (v) => navigate(href.compare(a, v)), 'Run B')}
      <a className="btn" href={href.compare(b, a)} title="Compare the other way round">
        Swap
      </a>
    </div>
  );
}

function ChangeCard({ k, changed, title, note }: { k: string; changed: boolean; title: string; note: string }) {
  return (
    <div className={changed ? 'diff' : undefined}>
      <span className="k">{k}</span>
      <b>{title}</b>
      <small>{note}</small>
    </div>
  );
}

function Changes({ c }: { c: RunComparison }) {
  const ch = c.changes;
  const codeChanged = (ch.code.a ?? '') !== (ch.code.b ?? '');
  const t = ch.tools;
  const toolsChanged = t.added.length > 0 || t.removed.length > 0 || t.redefined;
  const toolNote = [...t.added.map((x) => `+${x}`), ...t.removed.map((x) => `−${x}`)].join(' ') || (t.redefined ? 'a definition changed' : 'same declarations');
  const modelsChanged = ch.models.a.join() !== ch.models.b.join();
  return (
    <div className="changes">
      <ChangeCard k="code" changed={codeChanged} title={codeChanged ? `${ch.code.a ?? '—'} → ${ch.code.b ?? '—'}` : 'unchanged'} note={codeChanged ? 'different revision' : (ch.code.a ?? 'no revision recorded')} />
      <ChangeCard k="system prompt" changed={ch.systemPrompt} title={ch.systemPrompt ? 'changed' : 'unchanged'} note={ch.systemPrompt ? 'different prompt' : 'same prompt'} />
      <ChangeCard k="tools" changed={toolsChanged} title={toolsChanged ? 'changed' : 'unchanged'} note={toolNote} />
      <ChangeCard k="model" changed={modelsChanged} title={modelsChanged ? `${ch.models.a.join(', ') || 'none'} → ${ch.models.b.join(', ') || 'none'}` : 'unchanged'} note={modelsChanged ? 'different model' : ch.models.a.join(', ') || 'no model call'} />
    </div>
  );
}

function Prefix({ c }: { c: RunComparison }) {
  const n = c.identicalPrefix;
  const first = c.firstRequestDifference?.callNo ?? null;
  const cells = Math.max(1, Math.min(n, 120));
  return (
    <div className="prefix">
      <span className="ms" style={{ gridTemplateColumns: `repeat(${cells}, minmax(0, 1fr))` }} aria-hidden="true">
        {Array.from({ length: n ? cells : 0 }, (_, i) => (
          <i key={i} className="rep" />
        ))}
      </span>
      <span>
        <b>{n ? `#1–#${num(n)} identical.` : 'No identical prefix.'}</b>{' '}
        {first ? `The first request that differs is #${first}.` : c.responseDifferences.length ? 'Every request matches; some answers differ.' : c.onlyInA || c.onlyInB ? 'Every request they share matches.' : 'Every call matches.'}
      </span>
    </div>
  );
}

function FirstDifference({ c }: { c: RunComparison }) {
  const f = c.firstRequestDifference!;
  const diff = f.diff ?? [];
  return (
    <section className="diffpanel boxed">
      <div>
        <h4>
          #{f.callNo} in <a href={href.run(c.a.runId, f.callNo)}>{shortId(c.a.runId)}</a>
        </h4>
        <pre>
          {diff.length
            ? diff.slice(0, 12).map((e, i) => (
                <span key={i}>
                  {e.path}
                  {'\n'}
                  {e.op === 'added' ? '  (absent)' : `  ${clip(jsonText(e.before, false), 600)}`}
                  {'\n'}
                </span>
              ))
            : `${f.kind} ${callName(f.kind, f.name)}`}
        </pre>
      </div>
      <div>
        <h4>
          #{f.callNo} in <a href={href.run(c.b.runId, f.callNo)}>{shortId(c.b.runId)}</a>
        </h4>
        <pre>
          {diff.length
            ? diff.slice(0, 12).map((e, i) => (
                <span key={i}>
                  {e.path}
                  {'\n'}
                  <span className="add">{e.op === 'removed' ? '  (absent)' : `  ${clip(jsonText(e.after, false), 600)}`}</span>
                </span>
              ))
            : `${f.kind} ${callName(f.kind, f.name)}`}
        </pre>
      </div>
      <div className="hint">
        {diff.length
          ? `${diff.length === 1 ? 'One field differs' : `${diff.length} fields differ`}${diff.length > 12 ? '; the first 12 are shown' : ''}. Paths point into this call’s request, so an index counts entries inside it (messages, tools), not calls in the run.`
          : 'The stored requests are equal; they differ in what matching also reads: the headers that change model behaviour, or values normalizers treat differently.'}
        {f.hints?.map((h, i) => (
          <span key={i} className="hline">
            {h.message}
          </span>
        ))}
      </div>
    </section>
  );
}

function PathColumn({ run, calls, other, from, answer }: { run: RunDetail; calls: CallRow[]; other: CallRow[]; from: number; answer: string | null | undefined }) {
  const tag = runTag({ ...(run.run as unknown as RunLike), calls: run.calls.length, divergence: run.run.divergence, mode: run.run.mode, status: run.run.status } as RunLike);
  const shown = calls.slice(0, 200);
  return (
    <div>
      <h4>
        <Tag cls={tag.cls}>{tag.text}</Tag>
        <a href={href.run(run.run.runId, from + 1)}>{shortId(run.run.runId)}</a> after #{from}
      </h4>
      {shown.map((c, i) => {
        const o = other[i];
        // The call where the requests first differ is never "the same", whatever its name.
        const same = !!o && c.callNo !== from + 1 && o.kind === c.kind && o.name === c.name && o.detail === c.detail;
        return (
          <a key={c.callNo} className={`pcall${same ? ' same' : ''}`} href={href.run(run.run.runId, c.callNo)}>
            <span className="pn">#{c.callNo}</span>
            <span>
              {callName(c.kind, c.name)}
              {c.input ? <span className="eff input">input</span> : c.effect ? <span className={`eff ${c.effect}`}>{c.effect}</span> : null}
            </span>
            <Org origin={displayOrigin(c)} />
          </a>
        );
      })}
      {calls.length > shown.length ? <div className="pcall more">… {num(calls.length - shown.length)} more calls</div> : null}
      {calls.length === 0 ? <div className="pcall more">no calls after #{from}</div> : null}
      {answer ? <p className="pans">{clip(answer, 400)}</p> : null}
    </div>
  );
}

function Paths({ c, a, b }: { c: RunComparison; a: RunDetail; b: RunDetail }) {
  const from = c.firstRequestDifference ? c.firstRequestDifference.callNo - 1 : c.identicalPrefix;
  const ca = a.calls.filter((x) => x.callNo > from);
  const cb = b.calls.filter((x) => x.callNo > from);
  if (!ca.length && !cb.length) return null;
  return (
    <div className="paths">
      <PathColumn run={a} calls={ca} other={cb} from={from} answer={c.after?.a.answer} />
      <PathColumn run={b} calls={cb} other={ca} from={from} answer={c.after?.b.answer} />
    </div>
  );
}

function ResponseDifferences({ c }: { c: RunComparison }) {
  const first = c.firstRequestDifference?.callNo;
  if (!c.responseDifferences.length)
    return <p className="cmpnote">Same request, different response: none.{first ? ` The paths differ because the request at #${first} did.` : ''}</p>;
  return (
    <section className="panel cmpresp">
      <header>
        <h2>Same request, different answer</h2>
        <span className="sub">{c.responseDifferences.length === 1 ? '1 call' : `${c.responseDifferences.length} calls`}, before the first request that differs</span>
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
            {c.responseDifferences.map((r) => (
              <tr key={r.callNo}>
                <td className="num">{r.callNo}</td>
                <td>{callName(r.kind, r.name)}</td>
                <td className="wrapcell">{r.detail}</td>
                <td className="num">
                  <a href={href.run(c.a.runId, r.callNo)}>{shortId(c.a.runId).slice(-4)}</a> · <a href={href.run(c.b.runId, r.callNo)}>{shortId(c.b.runId).slice(-4)}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
