import { useState } from 'react';
import { JOB_KINDS, type JobView } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { CodeBox, CopyButton } from '../components/CodeBox.js';
import { Dialog } from '../components/Dialog.js';
import { DialogSteps, inCode } from '../components/DialogFacts.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { MigrateAskNow, MIGRATE_CARD } from '../components/MigrateDialog.js';
import { migrateCommand, type MigrateSwitch } from '../migrate-command.js';
import { useModelChoices } from '../components/ModelField.js';
import { Popover, useMenu } from '../components/Popover.js';
import { Section } from '../components/Section.js';
import { Status, type Tone } from '../components/Status.js';
import { glossed } from '../components/Term.js';
import { UpdateOutdated } from '../components/UpdateOutdated.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { useConsentStart } from '../fixes/FixJobButton.js';
import { outdatedOf, patchLines } from '../fixes/model.js';
import { Markdown } from '../fixes/parts.js';
import { useTreeBusy } from '../fixes/tree.js';
import { goldenName, shortId } from '../format.js';
import { addJobFooter } from '../job-actions.js';
import { ACTIONS } from '../labels.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import type { DecisionSessionView, MigrateApplyOffer, MigrateRetiring, MigrateUse, MigrateView, PreviewSession } from '../types.js';
import { DecisionCellPanel, openCell, openedCell } from './DecisionCell.js';
import { DecisionMatrix } from './DecisionMatrix.js';
import { rowTone } from './model.js';
import { SessionPicker } from './SessionPicker.js';

/**
 * A migration's page, worded on the server (src/migrate-view.ts): the migrations picker and Migrate
 * to…, the verdict with its one next step, What changes (the compact matrix, a cell opening under
 * it), What still passes with the goldens the switch leaves behind, What it costs, What to set, the
 * config change, the pull request body, and the command that made it. Words that name code come
 * between backticks and are set as code here.
 */
export function MigrateReport({ session, sessions, retiring, use, run, call }: { session: PreviewSession; sessions: readonly DecisionSessionView[]; retiring: readonly MigrateRetiring[]; use: readonly MigrateUse[]; run: string | null; call: number | null }) {
  const m = session.migration;
  if (!m) return null;
  const opened = openedCell(session, run, call);
  return (
    <>
      <div className="chbar">
        <SessionPicker kind="migrate" sessions={sessions} shown={session} />
        <span className="sp" />
        <MigrateToMenu m={m} retiring={retiring} use={use} goldens={goldensOf(session)} />
      </div>
      <MigrateVerdict session={session} m={m} />
      <Section title="What changes" sub={m.changes.sub} className="mgch">
        <DecisionMatrix compact session={session} open={opened ? { run: opened.row.runId, call: opened.callNo } : null} onOpen={(r, c, current) => openCell('migrate', session.sessionId, r, c, current)} />
        <ChangeSteps m={m} sessionId={session.sessionId} />
      </Section>
      {opened ? <DecisionCellPanel key={`${opened.row.runId}:${opened.callNo}`} session={session} row={opened.row} callNo={opened.callNo} /> : null}
      <Passes m={m} />
      <Section title="What it costs" className="mgcost">
        {[m.costs.perRun, m.costs.endToEnd, m.costs.checking].map((line) => (line ? <p key={line}>{glossed(line)}</p> : null))}
      </Section>
      <ToSet m={m} />
      <ConfigChange m={m} />
      <PullRequest m={m} />
      <Foot m={m} />
    </>
  );
}

/** The goldens a migration asked, by path, for Migrate to another model on the same goldens. */
const goldensOf = (session: PreviewSession): string[] => [...new Set(session.matrix.flatMap((r) => (r.golden ? [r.golden] : [])))];

/** The verdict: its word (applied, else Verdicts'), the headline, the switch and retirement lines, the goldens left to update, and the one next step. */
function MigrateVerdict({ session, m }: { session: PreviewSession; m: MigrateView }) {
  const facts = (
    <>
      <span className="pline">{m.headline.rest}</span>
      {m.retirements.map((r) => (
        <span key={r.text} className="pline">
          {r.text}
        </span>
      ))}
      {m.appliedLine ? <span className="pline mgl">{inCode(m.appliedLine)}</span> : null}
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
    <CopyButton text={body} label="the pull request body" name="Copy pull request body" sub="Markdown, the four blocks" {...(m.pullRequest?.gh ? { cmd: m.pullRequest.gh } : {})} className={lime ? 'btn lime' : 'btn'}>
      Copy pull request body
    </CopyButton>
  );
}

/** Migrate to…: the migration's from-models to another model, a menu of them, the recommendation marked, each opening Migrate's dialog. */
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
        Migrate to…
        <Icon name="caret" className="caret" />
      </ActionButton>
      {menu.anchor ? (
        <Popover anchor={menu.anchor} onClose={menu.close} className="fkm" label={`Migrate ${was} to…`}>
          <div className="pk">{`Migrate ${was} to…`}</div>
          {models.map((to) => (
            <button key={to} type="button" role="menuitemradio" aria-checked={to === m.to} data-tip={tipCard(`Migrate to ${to}`, [], MIGRATE_CARD, `$ ${migrateCommand({ from: m.from, to, goldens })}`)} onClick={() => ask(to)}>
              <b>{to}</b>
              {recommended.has(to) ? <small>recommended</small> : null}
            </button>
          ))}
        </Popover>
      ) : null}
      {asked ? <MigrateAskNow key={asked.at} s={asked.s} /> : null}
    </>
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
                <code key={l} className="mgarg">
                  {l}
                </code>
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
      {s.only ? <p>{s.only}</p> : null}
      {s.flags ? <p className="muted">{s.flags}</p> : null}
    </Section>
  );
}

/** A patch drawn as Apply fix draws one: each line in its colour. */
function Patch({ text }: { text: string }) {
  return (
    <pre className="fxcode fxpatch">
      {patchLines(text).map((l, i) => (
        <span key={i} className={l.tone ?? undefined}>
          {l.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** The config change: its files and places, the patch, what it leaves out and leaves for the hand, the review, `git apply`, and Copy config change. */
function ConfigChange({ m }: { m: MigrateView }) {
  const c = m.config;
  return (
    <Section title="The config change" sub={inCode(c.sub)} className="mgcfg">
      {c.patch ? <Patch text={c.patch} /> : null}
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
          <CopyButton text={c.patch} label="the config change" name="Copy config change" sub="the patch, as git apply takes it" {...(c.apply ? { cmd: c.apply } : {})} className="btn">
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

/** The foot: the report's warnings and notes, then the command that made the migration. */
function Foot({ m }: { m: MigrateView }) {
  const lines = [...m.warnings, ...m.notes];
  return (
    <div className="mgend">
      {lines.length ? (
        <ul className="dnotes">
          {lines.map((w) => (
            <li key={w}>{inCode(w)}</li>
          ))}
        </ul>
      ) : null}
      <CodeBox command={m.command} className="chcmd" />
    </div>
  );
}

/** Apply config change, lime while the tree is free: it asks first, then starts `migrate-apply`. Only where the server runs it. */
function ApplyButton({ sessionId, m, offer }: { sessionId: string; m: MigrateView; offer: MigrateApplyOffer }) {
  const app = useApp();
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
      {asking ? <ApplyDialog m={m} offer={offer} onOk={() => app.guard(() => void start({}))} onClose={() => setAsking(false)} /> : null}
      {consent}
    </>
  );
}

/** Apply config change?: what it does in steps, what it leaves out and which goldens diverge, the patch, the goldens left behind, and the command. */
function ApplyDialog({ m, offer, onOk, onClose }: { m: MigrateView; offer: MigrateApplyOffer; onOk: () => void; onClose: () => void }) {
  const behind = offer.leftBehind;
  const one = behind.length === 1;
  const steps = [
    { what: 'Patch applied', where: <>{inCode(offer.files.map((f) => `\`${f}\``).join(', '))}, with git apply</> },
    { what: 'Goldens replayed', where: 'offline, any that diverge are named' },
    ...(behind.length ? [{ what: 'Update goldens next', where: `to re-record ${one ? 'it' : 'them'} under ${m.to}` }] : []),
  ];
  const diverges = behind.length ? behind.map((g) => goldenName(g.golden)).join(', ') : 'no golden';
  return (
    <Dialog
      title={`${ACTIONS.applyConfigChange.label}?`}
      lead="Applies the migration’s config change to your working tree, for you to review before you commit."
      doc="migrate"
      facts={[
        offer.leftOut.length ? { label: 'Leaves out', value: inCode(offer.leftOut.map((f) => `\`${f}\``).join(', ')), quiet: 'as What to set says' } : null,
        { label: 'Diverges', value: diverges, quiet: offer.others ? `${offer.others} ${offer.others === 1 ? 'other doesn’t' : 'others don’t'}` : undefined },
      ]}
      command={offer.command}
      ok={ACTIONS.applyConfigChange.label}
      onOk={onOk}
      onClose={onClose}
    >
      <DialogSteps steps={steps} />
      {m.config.patch ? <Patch text={m.config.patch} /> : null}
      {behind.length ? (
        <div className="mgbehind">
          <h4>Left behind</h4>
          <ul>
            {behind.map((g) => (
              <li key={g.golden}>
                <code>{goldenName(g.golden)}</code> <span className="muted">{`#${g.callNo} · $.model`}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Dialog>
  );
}

/** The drawer after Apply config change: Update goldens on the goldens it left behind, else only Close. */
function MigrateApplyFooter({ job, plain }: { job: JobView; plain?: boolean }) {
  return job.done ? <UpdateOutdated outdated={outdatedOf(job.result)} id={job.id} lime={!plain} /> : null;
}

addJobFooter(JOB_KINDS.migrateApply, MigrateApplyFooter);
