import { useId, useMemo, useState } from 'react';
import { JOB_KINDS, type JobView } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { CodeBox, CopyButton } from '../components/CodeBox.js';
import { asWords, Code, CodeText, Copy } from '../components/Copy.js';
import { codeWords, inCode } from '../components/DialogFacts.js';
import { DotNodes } from '../components/DotParts.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { Markdown } from '../components/Markdown.js';
import { MigrateAskNow, MIGRATE_CARD, useMigrateEstimate } from '../components/MigrateDialog.js';
import { migrateCommand, type MigrateSwitch } from '../migrate-command.js';
import { useModelChoices } from '../components/ModelField.js';
import { Popover, useMenu } from '../components/Popover.js';
import { Section } from '../components/Section.js';
import { Status, type Tone } from '../components/Status.js';
import { glossed } from '../components/Term.js';
import { UpdateOutdated } from '../components/UpdateOutdated.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { useConsentStart } from '../fixes/FixJobButton.js';
import { outdatedOf, patchFiles } from '../fixes/model.js';
import { useTreeBusy } from '../fixes/tree.js';
import { goldenName, minuteStamp, shortId } from '../format.js';
import { addJobFooter } from '../job-actions.js';
import { ACTIONS } from '../labels.js';
import { personName } from '../person.js';
import { href } from '../route.js';
import { useServedParts } from '../served-parts.js';
import { tipEst } from '../spending.js';
import { useApp } from '../state.js';
import type { DecisionSessionView, MigrateApplyOffer, MigrateRetiring, MigrateUse, MigrateView, PreviewSession } from '../types.js';
import { DecisionCellPanel, openCell, openedCell } from './DecisionCell.js';
import { DecisionMatrix } from './DecisionMatrix.js';
import { Patch } from './Patch.js';
import { rowTone } from './model.js';
import { SessionPicker } from './SessionPicker.js';

/**
 * A migration's page, worded on the server (src/migrate-view.ts): the migrations picker and Migrate
 * to…, the verdict with its one next step, What changes (the compact matrix, a cell opening under
 * it), What still passes with the goldens the switch leaves behind, What it costs, What to set, the
 * config change a file a row with its diff behind Show diff, the pull request body behind Show body,
 * and the command that made it. Words that name code come between backticks and are set as code here.
 */
export function MigrateReport({ session, sessions, more = false, retiring, use, run, call }: { session: PreviewSession; sessions: readonly DecisionSessionView[]; more?: boolean; retiring: readonly MigrateRetiring[]; use: readonly MigrateUse[]; run: string | null; call: number | null }) {
  const m = session.migration;
  if (!m) return null;
  const opened = openedCell(session, run, call);
  return (
    <>
      <div className="chbar">
        <SessionPicker kind="migrate" sessions={sessions} shown={session} more={more} />
        <span className="sp" />
        <MigrateToMenu m={m} retiring={retiring} use={use} goldens={goldensOf(session)} />
      </div>
      <MigrateVerdict session={session} m={m} />
      <Section title="What changes" sub={m.changes.sub} className="mgch">
        <DecisionMatrix compact session={session} open={opened ? { run: opened.row.runId, call: opened.callNo } : null} onOpen={(r, c, current) => openCell('migrate', session.sessionId, r, c, current)} />
        <ChangeSteps m={m} sessionId={session.sessionId} />
      </Section>
      {opened ? <DecisionCellPanel key={`${opened.row.runId}:${opened.callNo}`} session={session} row={opened.row} callNo={opened.callNo} /> : null}
      <div className="grid2 secs">
        <Passes m={m} />
        <Section title="What it costs" className="mgcost">
          {m.costs.map((c) => (
            <p key={c.label}>
              <span className="k">{c.label}</span>
              <span>
                <DotNodes parts={c.text.split(' · ').map((t) => ({ text: t, node: glossed(t, true) }))} />
              </span>
            </p>
          ))}
        </Section>
      </div>
      <ToSet m={m} />
      <ConfigChange m={m} />
      <PullRequest m={m} />
      <Foot m={m} />
    </>
  );
}

/** The goldens a migration asked, by path, for Migrate to another model on the same goldens. */
const goldensOf = (session: PreviewSession): string[] => [...new Set(session.matrix.flatMap((r) => (r.golden ? [r.golden] : [])))];

/** When a migration's config change went into the working tree, and who put it there where names show: `applied Nov 6, 14:05 by Ana`. */
export const appliedWhen = (a: NonNullable<MigrateView['applied']>): string => `applied ${minuteStamp(a.at)}${a.by ? ` by ${personName(a.by)}` : ''}`;

/** The verdict: its word (applied, else Verdicts'), the headline, the switch and retirement lines, when it was applied and by whom, the goldens left to update, and the one next step. */
function MigrateVerdict({ session, m }: { session: PreviewSession; m: MigrateView }) {
  const facts = (
    <>
      <span className="pline">{asWords(m.headline.rest)}</span>
      {m.retirements.map((r) => (
        <span key={r.text} className="pline">
          {asWords(r.text)}
        </span>
      ))}
      {m.applied ? <span className="pline">{appliedWhen(m.applied)}</span> : null}
      {m.appliedLine ? <span className="pline">{codeWords(m.appliedLine)}</span> : null}
    </>
  );
  return (
    <VerdictLine word={m.word.text} tone={rowTone(m.word.tone)} facts={facts} actions={<NextStep session={session} m={m} />} className="dverdict mgverdict">
      {m.headline.text}
    </VerdictLine>
  );
}

/** The one lime next step: Apply config change, Update goldens while any waits, Copy pull request body once none does; else none. */
function NextStep({ session, m }: { session: PreviewSession; m: MigrateView }) {
  if (m.next === 'apply' && 'files' in m.apply) return <ApplyButton sessionId={session.sessionId} m={m} offer={m.apply} />;
  if (m.next === 'update' && m.applied) return <UpdateOutdated outdated={m.applied.outdated.filter((g) => g.waits)} id={session.sessionId} lime sub={`Each is re-recorded under ${m.to}, writes stubbed`} />;
  if (m.next === 'copy-pull-request' && m.pullRequest) return <CopyBody m={m} body={m.pullRequest.body} lime />;
  return null;
}

/** Copy pull request body: its card says what it copies. */
function CopyBody({ m, body, lime = false }: { m: MigrateView; body: string; lime?: boolean }) {
  return (
    <CopyButton text={body} label="the pull request body" name="Copy pull request body" sub="Markdown, the four blocks" {...(m.pullRequest?.gh ? { cmd: `$ ${m.pullRequest.gh}` } : {})} className={lime ? 'btn lime' : 'btn'}>
      Copy pull request body
    </CopyButton>
  );
}

/** Migrate to: the migration's from-models to another model, a menu of them headed `Migrate <from> to…`, the recommendation marked, each priced on its card once asked for, opening Migrate's dialog. */
function MigrateToMenu({ m, retiring, use, goldens }: { m: MigrateView; retiring: readonly MigrateRetiring[]; use: readonly MigrateUse[]; goldens: string[] }) {
  const app = useApp();
  const menu = useMenu();
  const [asked, setAsked] = useState<{ s: MigrateSwitch; at: number } | null>(null);
  const listing = useModelChoices();
  if (app.exported || !app.hasKind(JOB_KINDS.migrate)) return null;
  const was = m.from.join(', ') || 'the recorded model';
  const recommended = new Set(retiring.filter((n) => m.from.includes(n.model)).flatMap((n) => n.replacements));
  const models = [...new Set([...recommended, m.to, ...use.map((u) => u.model), ...(listing?.choices.map((c) => c.id) ?? [])])].filter((x) => !m.from.includes(x)).slice(0, 12);
  const ask = (to: string) => {
    menu.close();
    setAsked({ s: { from: m.from, to, goldens }, at: Date.now() });
  };
  return (
    <>
      <ActionButton className="btn" aria-haspopup="menu" aria-expanded={menu.open} tip={`Migrate ${was} to another model`} command={`$ shadowlap migrate --to <model> …`} onClick={(e) => menu.toggle(e.currentTarget)}>
        Migrate to
        <Icon name="caret" className="caret" />
      </ActionButton>
      {menu.anchor ? (
        <Popover anchor={menu.anchor} onClose={menu.close} className="fkm" label={`Migrate ${was} to…`}>
          <div className="pk">{`Migrate ${was} to…`}</div>
          {models.map((to) => (
            <MigrateToItem key={to} s={{ from: m.from, to, goldens }} checked={to === m.to} recommended={recommended.has(to)} onPick={() => ask(to)} />
          ))}
        </Popover>
      ) : null}
      {asked ? <MigrateAskNow key={asked.at} s={asked.s} /> : null}
    </>
  );
}

/**
 * A model in Migrate to's menu: its card the switch's command and what it bills. The price is read
 * once the pointer or the focus reaches it, as a Needs a look step's is, never for the whole menu as
 * it opens: each read reads every golden's calls on the pool.
 */
function MigrateToItem({ s, checked, recommended, onPick }: { s: MigrateSwitch; checked: boolean; recommended: boolean; onPick: () => void }) {
  const [asked, setAsked] = useState(false);
  const { estimate } = useMigrateEstimate(s, asked);
  const ask = () => setAsked(true);
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} data-tip={tipCard(`Migrate to ${s.to}`, [], MIGRATE_CARD, `$ ${migrateCommand(s)}`, tipEst(asked ? estimate : undefined, true))} onPointerEnter={ask} onFocus={ask} onClick={onPick}>
      <b>{s.to}</b>
      {recommended ? <small>recommended</small> : null}
    </button>
  );
}

/** Each write, stop and judged change, its rank in its colour, its name and call opening its cell, its detail and argument lines; else the line that none was. */
function ChangeSteps({ m, sessionId }: { m: MigrateView; sessionId: string }) {
  return (
    <>
      {m.changes.steps.length ? (
        <ul className="mgrows mgsteps">
          {m.changes.steps.map((s) => (
            <li key={`${s.runId}:${s.callNo}`}>
              <b className={`dsd q${s.rank}`}>rank {s.rank}</b>
              <a
                className="more"
                href={href.changeSession('migrate', sessionId, s.runId, s.callNo)}
                onClick={(e) => {
                  e.preventDefault();
                  openCell('migrate', sessionId, s.runId, s.callNo, false);
                }}
              >
                <code>{`${s.golden ? goldenName(s.golden) : shortId(s.runId)} #${s.callNo}`}</code>
              </a>
              <span className="mgw">{s.detail}</span>
              {s.lines.map((l) => (
                <CodeText key={l} className="mgarg">
                  {l}
                </CodeText>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      {m.changes.none ? <p className="muted">{m.changes.none}</p> : null}
      {m.changes.besides ? <p className="muted">{m.changes.besides}</p> : null}
    </>
  );
}

const PASS_TONES: Record<string, Tone> = { passed: 'ok', failed: 'err', inconclusive: 'warn' };

/** What still passes: each run's status and words, a golden the switch leaves behind, the rules, how many it verified end to end, and its notes. */
function Passes({ m }: { m: MigrateView }) {
  const p = m.passes;
  return (
    <Section title="What still passes" className="mgpass">
      <ul className="mgrows">
        {p.runs.map((x) => (
          <li key={x.runId}>
            <span className="mgn">{x.golden ? goldenName(x.golden) : shortId(x.runId)}</span>
            <Status tone={PASS_TONES[x.verdict] ?? 'mu'}>{x.verdict}</Status>
            <span className="mgw">{glossed(x.words)}</span>
            {x.leftBehind ? <span className="mgleft">{inCode(x.leftBehind)}</span> : null}
          </li>
        ))}
      </ul>
      {p.rules.map((r) => (
        <p key={r.rule} className="mgrule">
          {glossed(r.rule)}
          {p.rules.length > 1 ? `: ${r.runs.map(goldenName).join(', ')}` : ''}
        </p>
      ))}
      <p className="mgrule">{p.verified}</p>
      {[p.notVerified, ...p.notes].map((n) => (n ? <p key={n} className="mgrule dsy">{n}</p> : null))}
    </Section>
  );
}

/** What to set: each field the new model refuses and why, the fields given, or only the model; the flags verify took. */
function ToSet({ m }: { m: MigrateView }) {
  const s = m.set;
  return (
    <Section title="What to set" sub={s.sub} className="mgset">
      {s.fields.map((f) => (
        <div key={f.text} className="mgfield">
          <b>{inCode(f.text)}</b>
          <p className="muted">{inCode(f.why)}</p>
        </div>
      ))}
      {s.given.map((g) => (
        <p key={g}>{inCode(g)}</p>
      ))}
      {s.only ? <p>{inCode(s.only)}</p> : null}
      {s.flags ? <p className="muted">{inCode(s.flags)}</p> : null}
    </Section>
  );
}

/**
 * The patch a file a row: its path, the lines its part adds (in ink) and takes out (in red), and
 * Show diff, which draws the file's hunks under its row. Folded at first: the rows say what changes
 * where, and Copy config change has the whole patch either way.
 */
function PatchFiles({ patch }: { patch: string }) {
  const files = useMemo(() => patchFiles(patch), [patch]);
  const [open, setOpen] = useState<readonly number[]>([]);
  const id = useId();
  return (
    <ul className="mgfiles">
      {files.map((f, i) => {
        const shown = open.includes(i);
        return (
          <li key={`${i}:${f.path}`}>
            <div className="mgfile">
              <Code>{f.path}</Code>
              <span className="mgstat">
                {f.added ? <span className="add">{`+${f.added}`}</span> : null}
                {f.added && f.removed ? ' ' : null}
                {f.removed ? <span className="del">{`−${f.removed}`}</span> : null}
              </span>
              <button type="button" className="linkbtn" aria-expanded={shown} aria-controls={shown ? `${id}-${i}` : undefined} aria-label={`${shown ? 'Hide' : 'Show'} diff of ${f.path}`} onClick={() => setOpen(shown ? open.filter((x) => x !== i) : [...open, i])}>
                {shown ? 'Hide diff' : 'Show diff'}
                <Icon name="caret" />
              </button>
            </div>
            {shown ? (
              <div id={`${id}-${i}`}>
                <Patch text={f.text} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The config change: its files and places, a row a file with its diff behind Show diff, what it leaves out and leaves for the hand, the review, `git apply`, and Copy config change. */
function ConfigChange({ m }: { m: MigrateView }) {
  const c = m.config;
  return (
    <Section title="The config change" sub={inCode(c.sub)} className="mgcfg">
      {c.patch ? <PatchFiles patch={c.patch} /> : null}
      {c.leftOut ? <p className="mgalso inpatch">{inCode(c.leftOut)}</p> : null}
      {c.byHand ? <p className="mgalso">{inCode(c.byHand)}</p> : null}
      {c.noFile ? <p>{inCode(c.noFile)}</p> : null}
      {c.review.map((r) => (
        <p key={`${r.path}:${r.line}`} className="mgrev">
          Left for review: <code>{`${r.path}:${r.line}`}</code> {r.text}
        </p>
      ))}
      {c.apply ? <CodeBox command={c.apply} className="mgcmd" /> : null}
      {c.patch ? (
        <div className="actions">
          <CopyButton text={c.patch} label="the config change" name="Copy config change" sub="the patch, as git apply takes it" {...(c.apply ? { cmd: `$ ${c.apply}` } : {})} className="btn">
            Copy config change
          </CopyButton>
        </div>
      ) : null}
    </Section>
  );
}

/** The pull request body: its title, `gh pr create`, Copy pull request body, and Show body drawing it whole. */
function PullRequest({ m }: { m: MigrateView }) {
  const [open, setOpen] = useState(false);
  const pr = m.pullRequest;
  if (!pr) return null;
  return (
    <Section title="The pull request body" sub={pr.title} className="mgpr">
      {pr.gh ? <CodeBox command={pr.gh} className="mgcmd" /> : null}
      <div className="actions">
        <CopyBody m={m} body={pr.body} />
        <button type="button" className="linkbtn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide body' : 'Show body'}
        </button>
      </div>
      {open ? <Markdown text={pr.body} /> : null}
    </Section>
  );
}

/**
 * The foot: the report's warnings and notes, then the command that made the migration. A warning
 * holds what failed as the server said it, so it stays as written; a note is the report's own
 * sentence, set as copy.
 */
function Foot({ m }: { m: MigrateView }) {
  return (
    <div className="mgend">
      {m.warnings.length || m.notes.length ? (
        <ul className="dnotes">
          {m.warnings.map((w) => (
            <li key={w}>{inCode(w)}</li>
          ))}
          {m.notes.map((n) => (
            <Copy key={n} as="li">
              {inCode(n)}
            </Copy>
          ))}
        </ul>
      ) : null}
      <CodeBox command={m.command} className="chcmd" />
    </div>
  );
}

/**
 * Apply config change, lime while the tree is free: it asks first, in its dialog, a part the served
 * dashboard hands in (changes/ApplyConfigDialog.tsx), then starts `migrate-apply`. Only where the server runs it.
 */
function ApplyButton({ sessionId, m, offer }: { sessionId: string; m: MigrateView; offer: MigrateApplyOffer }) {
  const app = useApp();
  const { ApplyConfigDialog } = useServedParts();
  const busy = useTreeBusy('writes', 'apply the config change');
  const [asking, setAsking] = useState(false);
  const { start, consent } = useConsentStart(JOB_KINDS.migrateApply, { migrationId: sessionId });
  if (app.exported || !app.hasKind(JOB_KINDS.migrateApply)) return null;
  const label = ACTIONS.applyConfigChange.label;
  return (
    <>
      <ActionButton className={busy ? 'btn' : 'btn lime'} why={busy} tip={label} sub="Asks first: it changes your working tree" command={`$ ${offer.command}`} onClick={() => setAsking(true)}>
        {label}
      </ActionButton>
      {asking && ApplyConfigDialog ? <ApplyConfigDialog m={m} offer={offer} onOk={() => app.guard(() => void start({}))} onClose={() => setAsking(false)} /> : null}
      {consent}
    </>
  );
}

/** The drawer after Apply config change: Update goldens on the goldens it left behind, else only Close. */
function MigrateApplyFooter({ job, plain }: { job: JobView; plain?: boolean }) {
  return job.done ? <UpdateOutdated outdated={outdatedOf(job.result)} id={job.id} lime={!plain} /> : null;
}

addJobFooter(JOB_KINDS.migrateApply, MigrateApplyFooter);
