import { Fragment, useRef, type ReactNode } from 'react';
import type { TaskUpdate, TrainingView } from '../../api.js';
import { Org } from '../../components/bits.js';
import { CodeBox } from '../../components/CodeBox.js';
import { tipCard } from '../../components/HoverCard.js';
import { Section } from '../../components/Section.js';
import { Status } from '../../components/Status.js';
import { rowOpen } from '../../components/Table.js';
import { Term } from '../../components/Term.js';
import { VerdictLine } from '../../components/VerdictLine.js';
import { asWords } from '../../components/Copy.js';
import { plural } from '../../format.js';
import { useListKeys } from '../../list-keys.js';
import { ORIGIN_NAME } from '../../origins.js';
import { navigate } from '../../router.js';

type Tasks = TrainingView['tasks'];
type Row = Tasks['rows'][number];
/** A task's Update golden, drawn by the page, which holds its dialog. */
export type UpdateButton = (update: TaskUpdate, name: string) => ReactNode;

/**
 * Ready tasks that all reward the same behaviour can be passed by a model that does only that: a
 * verdict line, its word first. One ready task says so, rather than all of them.
 */
export function OneSided({ w, ready, update }: { w: NonNullable<Tasks['warning']>; ready: number; update: UpdateButton | null }) {
  const one = ready === 1;
  const step = w.fix?.update ? (
    update ? update(w.fix.update, w.name ?? w.fix.update.golden) : null
  ) : w.fix?.href ? (
    <a className="btn sm" href={w.fix.href}>
      {w.fix.label}
    </a>
  ) : null;
  return (
    <VerdictLine
      word="one-sided"
      tone="warn"
      actions={step}
      facts={
        <>
          {one ? 'It rewards' : 'All of them reward'} “{w.rewards}”, so a model that learned only that would score full marks.
          {w.name ? (
            <>
              {' '}
              <code>{w.name}</code> rewards the opposite once {w.once}.
            </>
          ) : null}
        </>
      }
    >
      {one ? 'The one ready task rewards one thing' : 'Every ready task rewards the same thing'}
    </VerdictLine>
  );
}

/**
 * What runs after the takeover, a line an origin, its word first (*stubbed* a glossary term, as it
 * isn't a word that says itself): past four tools, three and how many more, every name on the more's card.
 */
function TakeoverLine({ origin, names }: { origin: 'live' | 'stub'; names: readonly string[] }) {
  if (!names.length) return null;
  const shown = names.length > 4 ? names.slice(0, 3) : names;
  const more = names.length - shown.length;
  return (
    <span className="tkol">
      <span className="tkk">
        <Org origin={origin}>{origin === 'stub' ? <Term k="stubbed" /> : null}</Org>
      </span>
      <span className="tkn">
        {shown.map((n, i) => (
          <Fragment key={n}>
            {i ? ', ' : ''}
            <code className={origin === 'stub' ? 'wr' : undefined}>{n}</code>
          </Fragment>
        ))}
        {more ? (
          <>
            {' '}
            <span className="tkm" data-tip={tipCard(`${plural(names.length, 'tool')} ${ORIGIN_NAME[origin]}`, [], names.join(', '))}>
              +{more} more
            </span>
            <span className="sr">: {names.slice(shown.length).join(', ')}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}

/** A task's status: a dot and its word, why under it, and Update golden where its test's early fork blocks it. */
const STATUS_TONE = { ok: 'ok', y: 'warn', n: 'mu' } as const;

/**
 * The tasks, a row each: the golden and where a model takes over, its checks, what runs after the
 * takeover, and its status. A row that leads somewhere opens it, by the pointer or Enter; j and k
 * walk them.
 */
export function TaskTable({ rows, update }: { rows: Tasks['rows']; update: UpdateButton | null }) {
  const box = useRef<HTMLTableElement>(null);
  const inFocus = useListKeys<Row>({ rows, keyOf: (r) => r.golden, root: box, open: (r) => (r.href ? navigate(r.href) : undefined) });
  return (
    <Section title="Tasks" sub="a model takes over at one call, and the checks score what it did">
      <div className="tscroll">
        <table className="t gt tasks" ref={box}>
          <thead>
            <tr>
              <th>Task</th>
              <th className="hide-sm">Scored by</th>
              <th className="hide-md">After the takeover</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.golden} data-rowkey={r.golden} className={[r.href ? '' : 'static', inFocus === r.golden ? 'krow' : ''].join(' ').trim() || undefined} {...(r.href ? rowOpen(() => navigate(r.href!)) : {})}>
                <td>
                  {r.href ? (
                    <a className="rowa" href={r.href} title={r.opens ?? undefined}>
                      <code>{r.name}</code>
                    </a>
                  ) : (
                    <code>{r.name}</code>
                  )}
                  <span className="rsub">{asWords(r.sub)}</span>
                </td>
                <td className="chk hide-sm">
                  {r.checks.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </td>
                <td className="hide-md tko">
                  {r.after ? (
                    <>
                      <TakeoverLine origin="live" names={r.after.live} />
                      <TakeoverLine origin="stub" names={r.after.stubbed} />
                    </>
                  ) : null}
                </td>
                <td>
                  <Status tone={STATUS_TONE[r.status.badge]}>{r.status.label}</Status>
                  {r.status.short ? <span className="rsub">{r.status.short}</span> : null}
                  {r.update && update ? <div className="trupd">{update(r.update, r.name)}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** Serving tasks to a training loop, and what a score can't tell you, side by side. */
export function TaskNotes({ view }: { view: TrainingView }) {
  const weak = view.tasks.weak;
  return (
    <div className="grid2 secs">
      <Section title="From a training loop" sub="one HTTP call per attempt">
        <div className="pbody">
          <p className="muted">Serve the model you’re training on an OpenAI-compatible endpoint. Each attempt returns its score, to use as the reward.</p>
          <CodeBox command={view.serve?.command ?? 'shadowlap tasks serve goldens/ --port 4779'} />
          {view.serve ? (
            <>
              {/* Nothing was asked: an example, with a placeholder run and one check missed, so a score reads as the share passed. */}
              <p className="muted trafter">For example, one attempt and the score it answers with:</p>
              <pre tabIndex={0} className="report trserve">{`${view.serve.request}\n\n${view.serve.response}`}</pre>
            </>
          ) : (
            <p className="muted trafter">Once a task is ready, each request scores one attempt at it.</p>
          )}
        </div>
      </Section>
      <Section title="What a score can’t tell you">
        <div className="lrows">
          <div>
            <span>
              <b>Reads run live.</b>
              <span className="rsub">
                After the takeover, read tools call the real services, so those must be up. <code>--reads replay</code> serves matching calls from the recording instead.
              </span>
            </span>
          </div>
          <div>
            <span>
              <b>Writes are stubbed.</b>
              <span className="rsub">A task can’t score what a write would have caused.</span>
            </span>
          </div>
          <div>
            <span>
              <b>A model learns what the checks reward.</b>
              <span className="rsub">
                Weak checks teach the wrong thing
                {weak ? (
                  <>
                    . That’s why <code>{weak}</code> isn’t a task.
                  </>
                ) : (
                  '.'
                )}
              </span>
            </span>
          </div>
        </div>
      </Section>
    </div>
  );
}
