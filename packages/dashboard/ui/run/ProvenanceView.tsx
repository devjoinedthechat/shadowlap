import { useEffect, useRef, useState } from 'react';
import { ABOUT_FROM } from '../../../engine/src/about.js';
import type { LineageNode, ProvenanceView as ServerProvenance, RunDetail } from '../api.js';
import { AboutLine, useFitAbouts } from '../components/About.js';
import { CopyButton, Org } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { copyText } from '../dom.js';
import { RunIcon } from '../components/RunIcon.js';
import { callName, num, shortFingerprint, shortHash, shortId, stamp, utcStamp } from '../format.js';
import { useLoad } from '../hooks.js';
import { countOrigins, ORIGIN_NAME, presentOrigins } from '../origins.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { kindWord } from '../runs.js';
import { scopesOf } from '../scopes.js';
import { useApp } from '../state.js';
import { flagText } from './banner.js';
import { lineageRunLike, modelLabel, originOf, pulledSpender, runLikeOf } from './model.js';
import { copyRules, endpointSamples, lineageWords, tallyProviders, upstreamParts } from './provenance.js';
import { useWindow } from './window-hook.js';

/**
 * The providers a run's model calls went to, with how many calls each: the server's count when it
 * sends one, else read from one call of each endpoint the run used (a call's details name its
 * provider). Null while it is being worked out or when no call says.
 */
function useProviders(run: RunDetail, server: ServerProvenance | null): Array<{ provider: string; calls: number }> | null {
  const { client } = useApp();
  const [found, setFound] = useState<Array<{ provider: string; calls: number }> | null>(null);
  const runId = run.run.runId;
  const known = server?.providers ?? null;
  const sig = JSON.stringify(endpointSamples(run.calls));
  useEffect(() => {
    if (known) return;
    const asked = JSON.parse(sig) as Array<{ first: number; calls: number }>;
    if (!asked.length) return setFound([]);
    let alive = true;
    void Promise.all(asked.map((e) => client.call(runId, e.first).then((d) => ({ provider: d.call.provider, calls: e.calls }), () => ({ provider: null, calls: e.calls })))).then((list) => alive && setFound(tallyProviders(list)));
    return () => {
      alive = false;
    };
  }, [client, runId, sig, known]);
  return known ?? found;
}

/** The requests and what they cost, kept on one line, then who spent it for a run pulled from the team store. */
function UpstreamValue({ text, note }: { text: string; note: string | null }) {
  return (
    <>
      <span className="nw">{text}</span>
      {note ? (
        <>
          {' '}
          <small className="nw">{note}</small>
        </>
      ) : null}
    </>
  );
}

/**
 * Provenance: the run's record (command, code version, times in UTC, models, provider, upstream
 * requests, origins), its lineage, each call's fingerprint and blobs when the server sends them,
 * what a copy made now would mask, and its labels and notes. The calls' ledger draws only the rows
 * in view (window-hook.ts).
 */

const LEDGER_ROWS = { keyOf: (c: RunDetail['calls'][number]) => c.callNo, shapeOf: () => 'row', estimate: () => 39 };
export function ProvenanceView({ run, selected }: { run: RunDetail; selected?: number | null }) {
  const { client, meta, exported, toast, runs } = useApp();
  const r = run.run;
  const s = run.summary;
  const lineage = useLoad(() => client.lineage(r.runId), r.runId);
  // `show --json` as the CLI prints it, read ahead so Copy writes it at once (a browser only lets a click copy).
  const show = useLoad(() => (exported ? null : client.showJson(r.runId)), `${r.runId}:show`);
  // The server's record of the run, when it works one out: on the run, or from its own endpoint.
  const fetched = useLoad(() => (run.provenance ? null : client.provenance(r.runId)), `${r.runId}:provenance`);
  const prov = run.provenance ?? fetched.data ?? null;
  // What a copy would mask is yet to be counted while the redaction previews are busy (Settings →
  // Redaction reading runs): asked again every few seconds, for a minute, until it is.
  const counting = !!prov?.mask?.busy;
  const { reload } = fetched;
  const [asked, setAsked] = useState({ runId: r.runId, times: 0 });
  const times = asked.runId === r.runId ? asked.times : 0;
  useEffect(() => {
    if (!counting || times >= 20) return;
    const t = setTimeout(() => {
      setAsked({ runId: r.runId, times: times + 1 });
      reload();
    }, 3000);
    return () => clearTimeout(t);
  }, [counting, times, reload, r.runId]);
  const providers = useProviders(run, prov);
  // Each model as the page names it everywhere (claude-opus-5), counted from the record when it says,
  // else from the calls; the id the provider recorded (a dated one) shows on hover when it says more.
  const models = new Map<string, { calls: number; recorded: string[] }>();
  const count = (model: string, n: number, recorded: string | null) => {
    const name = modelLabel(run.models, model) ?? model;
    const m = models.get(name) ?? { calls: 0, recorded: [] };
    m.calls += n;
    if (recorded && recorded !== name && !m.recorded.includes(recorded)) m.recorded.push(recorded);
    models.set(name, m);
  };
  const endpoints = new Set<string>();
  for (const c of run.calls) {
    if (c.kind !== 'api') continue;
    if (c.model && !prov?.models?.length) count(c.model, 1, null);
    endpoints.add(c.name);
  }
  for (const m of prov?.models ?? []) count(m.model, m.calls, m.model);
  const revOf = new Map((prov?.lineage ?? []).map((n) => [n.runId, n.codeVersion]));
  const origins = countOrigins(run.calls.map(originOf));
  const scopes = scopesOf(run.calls);
  const like = runLikeOf(run);
  const flag = flagText(run.intervention ?? null);
  const what = r.divergence ? `fork at #${r.divergence.callNo}${run.parent ? ` of ${shortId(run.parent.runId)}` : ''}${flag ? ` · ${flag}` : ''}` : run.parent ? `${kindWord(like)} of ${shortId(run.parent.runId)}${r.meta?.test?.golden ? ` · ${r.meta.test.golden}` : ''}` : run.source ? `imported from ${run.source}` : 'recording';
  // The ancestors, oldest first, and this run.
  const chain: LineageNode[] = [];
  if (lineage.data) {
    const byId = new Map(lineage.data.map((n) => [n.runId, n]));
    let cur = byId.get(r.runId);
    while (cur && chain.length < 64) {
      chain.unshift(cur);
      cur = cur.parentRunId ? byId.get(cur.parentRunId) : undefined;
    }
  }
  const notes = r.meta?.notes ?? [];
  const labels = r.meta?.labels ?? [];
  const rules = prov?.mask?.rules ?? meta?.redactRules;
  const masked = prov?.mask?.values ?? null;
  // Not counted, and why: a rule that takes too long on the run's text, a run read only in part.
  const uncounted = prov?.mask?.why ?? null;
  const ledger = run.calls.some((c) => c.fingerprint || c.requestRef || c.responseRef);
  const box = useRef<HTMLDivElement>(null);
  useFitAbouts(box);
  const win = useWindow(ledger ? run.calls : NO_CALLS, LEDGER_ROWS);
  // What the run was about, whole, and on a line of its own where that comes from (decision 10).
  const about = run.about ?? null;
  const rows: Array<[string, React.ReactNode]> = [
    ['Run', <code key="r">{r.runId}</code>],
    ...(about?.text
      ? ([
          [
            'About',
            <span key="a">
              {about.text}
              <small className="from">{ABOUT_FROM[about.from] ?? about.from}</small>
            </span>,
          ],
        ] as Array<[string, React.ReactNode]>)
      : []),
    ['What it is', what],
    ['Command', run.source ? <span className="muted">none: imported from {run.source}</span> : <code key="c">{r.command.argv.join(' ')}</code>],
    ['Code version', r.codeVersion ? <code key="v">{r.codeVersion}</code> : '—'],
    ['Started', utcStamp(r.startedAt)],
    ['Ended', r.endedAt ? utcStamp(r.endedAt) : <span className="muted">{r.status === 'running' ? 'still recording' : '—'}</span>],
    [
      'Models',
      models.size
        ? [...models].map(([m, { calls: n, recorded }], i) => (
            <span key={m} title={recorded.length ? `recorded as ${recorded.join(', ')}` : undefined}>
              {i ? <br /> : null}
              {m} <small>{n === 1 ? '1 call' : `${num(n)} calls`}</small>
            </span>
          ))
        : '—',
    ],
    [
      'Provider',
      providers === null ? (
        <span className="muted">…</span>
      ) : providers.length ? (
        providers.map((p, i) => (
          <span key={p.provider}>
            {i ? <br /> : null}
            {p.provider} <small>{p.calls === 1 ? '1 call' : `${num(p.calls)} calls`}</small>
          </span>
        ))
      ) : endpoints.size ? (
        <code>{[...endpoints].join(', ')}</code>
      ) : (
        '—'
      ),
    ],
    ['Calls', `${num(s.byKind.api)} model · ${num(s.byKind.tool)} tool${s.byKind.clock + s.byKind.random ? ` · ${num(s.byKind.clock + s.byKind.random)} clock and random` : ''}${scopes.length ? ` · ${scopes.length} scopes` : ''}`],
    ['Upstream', <UpstreamValue key="u" {...upstreamParts(s.upstreamRequests, s.cost.spent, pulledSpender(r))} />],
    ['Origins', presentOrigins(origins).map((o) => `${num(origins[o])} ${ORIGIN_NAME[o]}`).join(' · ') || '—'],
  ];
  return (
    <div className="prov" ref={box}>
      <div className="provgrid">
        <section>
          <h3>Record</h3>
          <dl className="kvs">
            {rows.map(([k, v]) => (
              <Pair key={k} k={k} v={v} />
            ))}
          </dl>
        </section>
        <section>
          <h3>Lineage</h3>
          <ol className="lineage">
            {chain.length
              ? chain.map((n) => {
                  const here = n.runId === r.runId;
                  const nodeLike = here ? like : lineageRunLike(n, runs?.find((x) => x.runId === n.runId));
                  // What it is, or what it failed in red; an interrupted run says so after what it is.
                  const words = lineageWords(nodeLike, n.label);
                  return (
                    <li key={n.runId} className={here ? 'here' : undefined}>
                      <RunIcon run={nodeLike} className="" />
                      {/* Each run by its id and its about line, which under a parent is what it changed. */}
                      <a className="lt" href={href.run(n.runId)}>
                        <code>{shortId(n.runId)}</code>
                        <AboutLine about={n.about} />
                      </a>
                      <small>
                        {words.err ? <em>{words.err}</em> : null}
                        {words.text}
                        {here ? ' · this run' : ''}
                        {revOf.get(n.runId) ? ` · rev ${revOf.get(n.runId)}` : ''} · {stamp(n.startedAt)}
                      </small>
                    </li>
                  );
                })
              : null}
          </ol>
          <h3>Leaving this machine</h3>
          <p className="muted">
            A copy made now (pack, export html, export dataset or export pairs) applies{' '}
            <span title={uncounted ?? undefined}>{copyRules(rules, masked, !!uncounted, counting, prov?.mask?.unmasked ?? 0, prov?.mask?.returned ?? 0)}</span>
            .{' '}
            <a className="more" href={href.settings('redaction')}>
              {typeof rules === 'number' && rules ? 'Preview' : 'Settings'}
            </a>
          </p>
          <p className="muted">Exports aren’t signed. A pack’s blobs are checked against their hashes when it’s unpacked, and anything that fails imports nothing.</p>
          {labels.length || notes.length ? (
            <>
              <h3>Labels and notes</h3>
              {labels.length ? (
                <p className="muted">
                  {labels.map((l) => (
                    <span className="chip" key={l}>
                      {l}
                    </span>
                  ))}
                </p>
              ) : null}
              <div className="notes">
                {notes.map((n, i) => (
                  <div className="note" key={i}>
                    {n.callNo !== null ? <b>#{n.callNo}</b> : null} {n.text}
                    <small>{stamp(n.at)}</small>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </section>
      </div>
      {ledger ? (
        <section>
          <h3>Calls</h3>
          <div className="tscroll">
            <table className="t ledger">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Call</th>
                  {scopes.length ? <th>Scope</th> : null}
                  <th>Origin</th>
                  <th>Fingerprint</th>
                  <th>Response blob</th>
                </tr>
              </thead>
              <tbody ref={win.listRef}>
                {win.before ? (
                  <tr className="wspace" aria-hidden="true" style={{ height: win.before }}>
                    <td colSpan={scopes.length ? 6 : 5} />
                  </tr>
                ) : null}
                {run.calls.slice(win.start, win.end).map((c, j) => (
                  <tr key={c.callNo} data-wi={win.start + j} aria-selected={c.callNo === selected} onClick={() => navigate(href.run(r.runId, c.callNo, 'provenance'), true)}>
                    <td className="num left">{c.callNo}</td>
                    <td>{callName(c.kind, c.name)}</td>
                    {scopes.length ? (
                      <td>
                        <code>{c.scope ?? ''}</code>
                      </td>
                    ) : null}
                    <td>
                      <Org origin={originOf(c)} />
                    </td>
                    <td>
                      {/* The request blob is on the hover: the stored request, kept once like the response. */}
                      <code title={[c.fingerprint ? `sha256:${c.fingerprint}` : null, c.requestRef ? `request blob ${c.requestRef}` : null].filter(Boolean).join('\n') || undefined}>{c.fingerprint ? `${shortFingerprint(c.fingerprint)}…` : c.requestRef ? shortHash(c.requestRef) : '—'}</code>
                    </td>
                    <td>
                      <code title={c.responseRef ?? undefined}>{c.responseRef ? shortHash(c.responseRef) : '—'}</code>
                    </td>
                  </tr>
                ))}
                {win.after ? (
                  <tr className="wspace" aria-hidden="true" style={{ height: win.after }}>
                    <td colSpan={scopes.length ? 6 : 5} />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="muted">The fingerprint is what a replay matches a request on. The response blob is the stored answer, kept once and shared by every run that recorded it.</p>
        </section>
      ) : (
        <p className="muted">Each call’s fingerprint is in its Details tab, and every hash is in the run’s JSON record.</p>
      )}
      <div className="actions">
        {show.data !== null && show.data !== undefined ? (
          <button type="button" className="btn" title={`shadowlap show ${shortId(r.runId)} --json, as the CLI prints it`} onClick={() => void copyText(JSON.stringify(show.data, null, 2)).then((ok) => toast(ok ? 'Copied the run’s show --json' : 'Copying was refused by the browser'))}>
            <Icon name="copy" />
            Copy show --json
          </button>
        ) : (
          <CopyButton text={`shadowlap show ${shortId(r.runId)} --json`} label="the command" className="btn">
            Copy show --json
          </CopyButton>
        )}
      </div>
    </div>
  );
}

const NO_CALLS: RunDetail['calls'] = [];

function Pair({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
