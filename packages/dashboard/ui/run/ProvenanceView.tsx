import type { LineageNode, RunDetail } from '../api.js';
import { CopyButton, Org } from '../components/bits.js';
import { RunIcon } from '../components/RunIcon.js';
import { approx, callName, num, shortId, stamp, utcStamp } from '../format.js';
import { useLoad } from '../hooks.js';
import { countOrigins, ORIGIN_NAME, presentOrigins } from '../origins.js';
import { href } from '../route.js';
import { kindWord } from '../runs.js';
import { scopesOf } from '../scopes.js';
import { useApp } from '../state.js';
import { originOf, runLikeOf } from './model.js';

/**
 * Provenance: the run's record (command, code version, times in UTC, models, endpoints, upstream
 * requests, origins), its lineage, each call's fingerprint and blobs when the server sends them,
 * what a copy made now would carry, and its labels and notes.
 */
export function ProvenanceView({ run }: { run: RunDetail }) {
  const { client, meta } = useApp();
  const r = run.run;
  const s = run.summary;
  const lineage = useLoad(() => client.lineage(r.runId), r.runId);
  const models = new Map<string, number>();
  const endpoints = new Set<string>();
  for (const c of run.calls) {
    if (c.kind !== 'api') continue;
    if (c.model) models.set(c.model, (models.get(c.model) ?? 0) + 1);
    endpoints.add(c.name);
  }
  const origins = countOrigins(run.calls.map(originOf));
  const scopes = scopesOf(run.calls);
  const like = runLikeOf(run);
  const what = r.divergence ? `fork at #${r.divergence.callNo}${run.parent ? ` of ${shortId(run.parent.runId)}` : ''}` : run.parent ? `${kindWord(like)} of ${shortId(run.parent.runId)}` : run.source ? `imported from ${run.source}` : 'recording';
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
  const rules = meta?.redactRules;
  const ledger = run.calls.some((c) => c.fingerprint || c.requestRef || c.responseRef);
  const rows: Array<[string, React.ReactNode]> = [
    ['Run', <code key="r">{r.runId}</code>],
    ['What it is', what],
    ['Command', run.source ? <span className="muted">none: imported from {run.source}</span> : <code key="c">{r.command.argv.join(' ')}</code>],
    ['Code version', r.codeVersion ? <code key="v">{r.codeVersion}</code> : '—'],
    ['Started', utcStamp(r.startedAt)],
    ['Ended', r.endedAt ? utcStamp(r.endedAt) : <span className="muted">{r.status === 'running' ? 'still recording' : '—'}</span>],
    [
      'Models',
      models.size
        ? [...models].map(([m, n], i) => (
            <span key={m}>
              {i ? <br /> : null}
              {m} <small>{n === 1 ? '1 call' : `${num(n)} calls`}</small>
            </span>
          ))
        : '—',
    ],
    ['Endpoints', endpoints.size ? [...endpoints].join(', ') : '—'],
    ['Calls', `${num(s.byKind.api)} model · ${num(s.byKind.tool)} tool${s.byKind.clock + s.byKind.random ? ` · ${num(s.byKind.clock + s.byKind.random)} clock and random` : ''}${scopes.length ? ` · ${scopes.length} scopes` : ''}`],
    ['Upstream', `${num(s.upstreamRequests)} ${s.upstreamRequests === 1 ? 'request' : 'requests'} · ${approx(s.cost.spent)}`],
    ['Origins', presentOrigins(origins).map((o) => `${num(origins[o])} ${ORIGIN_NAME[o]}`).join(' · ') || '—'],
  ];
  return (
    <div className="prov">
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
                  return (
                    <li key={n.runId} className={here ? 'here' : undefined}>
                      <RunIcon run={{ ...like, runId: n.runId, parentRunId: n.parentRunId, mode: n.mode, status: n.status, divergence: n.divergence, calls: n.calls, test: here ? like.test ?? null : null, source: here ? like.source : null, covers: here ? like.covers : null }} className="" />
                      <a href={href.run(n.runId)}>
                        <code>{shortId(n.runId)}</code>
                      </a>
                      <small>
                        {n.label}
                        {here ? ' · this run' : ''} · {stamp(n.startedAt)}
                      </small>
                    </li>
                  );
                })
              : null}
          </ol>
          <h3>Leaving this machine</h3>
          <p className="muted">
            A copy made now (pack, export html, export dataset) applies{' '}
            {typeof rules === 'number' ? (rules ? `${rules} redaction ${rules === 1 ? 'rule' : 'rules'}` : 'no redaction rules: it would hold what was recorded') : 'the redaction rules in shadowlap.config.json'}
            .{' '}
            <a className="more" href={href.settings('redaction')}>
              Settings
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
              <tbody>
                {run.calls.map((c) => (
                  <tr key={c.callNo}>
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
                      <code>{c.fingerprint ?? c.requestRef ?? '—'}</code>
                    </td>
                    <td>
                      <code>{c.responseRef ?? '—'}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">The fingerprint is what a replay matches a request on. The response blob is the stored answer, kept once and shared by every run that recorded it.</p>
        </section>
      ) : (
        <p className="muted">Each call’s fingerprint is in its Details tab, and every hash is in the run’s JSON record.</p>
      )}
      <div className="actions">
        <CopyButton text={`shadowlap show ${shortId(r.runId)} --json`} label="the command" className="btn">
          Copy show --json
        </CopyButton>
      </div>
    </div>
  );
}

function Pair({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
