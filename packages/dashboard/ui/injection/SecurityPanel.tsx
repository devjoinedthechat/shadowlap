import { Fragment, type ReactNode } from 'react';
import type { SecurityRead, SecurityRow } from '../../src/injection-security.js';
import { JOB_KINDS } from '../api.js';
import { Id } from '../components/Id.js';
import { Section } from '../components/Section.js';
import { ErrorState, failedRead } from '../components/States.js';
import { Status } from '../components/Status.js';
import { statusTone } from '../components/status-tone.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { SECURITY_TEST_ASK } from '../page-ask.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import { readsWords } from './reads-words.js';
import { TestButton } from './TestButton.js';

/*
 * Tests → Security: the untrusted reads each golden's recording makes, where an injection test
 * plants, its last test or injection gate, and Run injection test… on it, asked as the fork menu's
 * is. The read is the server's (`GET /api/injection/security`, pooled): read again as an injection
 * test or Pack with injection gate… started here ends, and as a test session ends, so a row says the
 * test just run. None where no golden's recording reads anything untrusted.
 */

const ENDS = new Set<string>([JOB_KINDS.injection, JOB_KINDS.keepGolden]);

/** Names in code, joined by commas and a last `and`, as a sentence lists them. */
function named(names: readonly string[]): ReactNode {
  return names.map((n, i) => (
    <Fragment key={n}>
      {i ? (i === names.length - 1 ? ' and ' : ', ') : null}
      <code>{n}</code>
    </Fragment>
  ));
}

/** A golden's last test: its verdict, then injectionLine's words, saying so where it was the golden's gate; not tested where none planted. */
function Last({ last }: { last: SecurityRow['last'] }) {
  if (!last) return <Status tone="mu">not tested</Status>;
  return (
    <>
      <Status tone={statusTone(last.verdict)}>{last.verdict}</Status>
      <span className="rsub">{last.gate ? `${last.line} · its injection gate` : last.line}</span>
    </>
  );
}

function Row({ row }: { row: SecurityRow }) {
  const whose = `${row.name}’s recording`;
  return (
    <tr className="still">
      <td>
        <code>{row.name}</code>
        <span className="rsub">
          its recording <Id id={shortId(row.recording)} />
        </span>
      </td>
      <td className="sreads">
        {row.reads.map((r) => (
          <span key={r.callNo} className="nw">
            #{r.callNo} <code>{r.name}</code>
          </span>
        ))}
      </td>
      <td>
        <Last last={row.last} />
      </td>
      <td className="num">
        <TestButton className="btn sm" asked={{ ask: SECURITY_TEST_ASK, key: row.path }} test={{ runId: row.runId, golden: row.runId ? null : row.path, recording: row.recording, reads: row.reads, estimate: row.estimate }} sub={`Plants payloads at ${readsWords(row.reads)} of ${whose}`} />
      </td>
    </tr>
  );
}

/** What the section says it holds, under its title. */
const SUB = 'the untrusted reads each golden makes, where an injection test plants';

/**
 * Security on Tests, read as the page's goldens are in: nothing while it loads, since most projects'
 * goldens read nothing untrusted and the section shows only where one does; a read that failed says
 * so where the section goes, in the line every page says (`failedRead`), with Retry.
 */
export function SecurityPanel() {
  const { client, jobs, feeds } = useApp();
  const ended = jobs.filter((w) => w.job.done && ENDS.has(w.job.kind ?? '')).length;
  const loaded = useLoad(() => client.injectionSecurity(), 'injection-security', `${ended}:${feeds.tests ?? 0}`);
  if (loaded.data) return <SecurityTable read={loaded.data} />;
  return loaded.error ? (
    <Section title="Security" sub={SUB}>
      <ErrorState retry={loaded.reload}>{failedRead(loaded.error)}</ErrorState>
    </Section>
  ) : null;
}

/** The section once read: a row a golden whose recording reads something untrusted, one whose recording can't be read too; the rest named under it. */
export function SecurityTable({ read }: { read: SecurityRead }) {
  if (!read.goldens.length && !read.unread.length) return null;
  return (
    <Section title="Security" sub={SUB} actions={<a className="more" href={href.settings('tools')}>Trust on Settings → Tools</a>}>
      <div className="tscroll">
        <table className="t sect">
          <thead>
            <tr>
              <th>Golden</th>
              <th>Untrusted reads</th>
              <th>Last test</th>
              <th className="num">
                <span className="sr">Test</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {read.goldens.map((row) => (
              <Row key={row.path} row={row} />
            ))}
            {read.unread.map((u) => (
              <tr key={u.name} className="still">
                <td>
                  <code>{u.name}</code>
                </td>
                <td className="sreads" colSpan={3}>
                  {u.why}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {read.none.length ? <p className="muted secnone">{named(read.none)} read nothing untrusted.</p> : null}
    </Section>
  );
}
