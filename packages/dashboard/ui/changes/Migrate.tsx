import { type ReactNode, useEffect, useLayoutEffect, useState } from 'react';
import { MODEL_NAME } from '../../src/decisions-argv.js';
import { ApiError } from '../api.js';
import { forgetMigration, noteMigration } from '../changes-tab.js';
import { CodeBox } from '../components/CodeBox.js';
import { inCode } from '../components/DialogFacts.js';
import { Link } from '../components/Link.js';
import { MigrateAskNow, MigrateButton } from '../components/MigrateDialog.js';
import { migrateCommand, type MigrateSwitch } from '../migrate-command.js';
import { ModelField, useModelChoices } from '../components/ModelField.js';
import { NO_GOLDENS } from '../components/NewPreviewMenu.js';
import { EmptyState, ErrorState, failedRead, Skeleton } from '../components/States.js';
import { useLoad, type Loaded } from '../hooks.js';
import { MIGRATE_ASK } from '../page-ask.js';
import { href } from '../route.js';
import { Unshown } from '../shell/unshown.js';
import { useApp } from '../state.js';
import type { DecisionsListView, MigrateRetiring, MigrateStartView, MigrateUse } from '../types.js';
import { MigrateReport } from './MigrateReport.js';

/**
 * Changes › Migrate: a model switched with the evidence (`shadowlap migrate`). The bare tab opens on
 * the soonest-retiring model no migration has checked: its date, who recommends what, the goldens
 * and scopes that call it, Switch to and Migrate to <model>. With none, it opens the newest
 * migration; with no migration either, Switch from and To. A migration's page is its report
 * (MigrateReport.tsx). The tab, the nav and Go to come back to the migration last shown
 * (changes-tab.ts).
 */

/** How many migrations the picker lists: the most the server reads, the filter finding the rest. */
const LISTED = 200;

/** What Migrate does, before any migration: the dialog's lead, said of every golden. */
const INTRO = 'Migrate asks your goldens’ model calls again under the new model, then verifies end to end the runs the preview can’t clear, and compares what a run costs. It ends in one report, with the config change and a pull request body.';

interface MigrateTabProps {
  id: string | null;
  run: string | null;
  call: number | null;
  onMissing?: (error: Error) => void;
}

/**
 * What the page reads again as the store moves: a migration (`decisions`), and a test result, since a
 * golden a migration left behind waits until a result of it passed (Update goldens re-records it).
 */
const followed = (feeds: Readonly<Record<string, number>>): string => `${feeds.decisions ?? 0}:${feeds.tests ?? 0}`;

export function MigrateTab(props: MigrateTabProps) {
  const { client, feeds } = useApp();
  const start = useLoad(() => client.migrateStart(), 'migrate-start', followed(feeds));
  return (
    <>
      <PaletteAsks retiring={start.data?.retiring ?? null} />
      <MigrateBody {...props} start={start} />
    </>
  );
}

/** The palette's Migrate <a> to <b>: that model's dialog, as the tab shows or at once where it shows already. */
function PaletteAsks({ retiring }: { retiring: readonly MigrateRetiring[] | null }) {
  const [asked, setAsked] = useState<{ s: MigrateSwitch; at: number } | null>(null);
  useEffect(() => {
    if (!retiring) return;
    const open = (n: MigrateRetiring) => setAsked({ s: { from: [n.model], to: n.replacements[0] ?? '', goldens: n.goldens }, at: Date.now() });
    const offs = retiring.map((n) => {
      if (MIGRATE_ASK.take(n.model)) open(n);
      return MIGRATE_ASK.on(() => open(n), n.model);
    });
    return () => offs.forEach((off) => off());
  }, [retiring]);
  return asked?.s.to ? <MigrateAskNow key={asked.at} s={asked.s} /> : null;
}

function MigrateBody({ id, run, call, onMissing, start }: MigrateTabProps & { start: Loaded<MigrateStartView> }) {
  const { client, feeds } = useApp();
  const list = useLoad(() => client.decisionSessions('migrate', LISTED), 'migrate-sessions', `${feeds.decisions ?? 0}`);
  const sessions = list.data?.sessions;
  // Q21: the soonest-retiring model no migration has checked leads; once each is checked, the newest migration.
  const unchecked = start.data?.retiring.find((n) => !n.checked) ?? null;
  const shownId = id ?? (start.data && !unchecked ? (sessions?.[0]?.sessionId ?? null) : null);
  const detail = useLoad(() => (shownId ? client.decisionSession(shownId) : null), `decision-session:${shownId ?? ''}`, followed(feeds));
  const gone = detail.error instanceof ApiError && detail.error.status === 404;
  const session = detail.data;
  useEffect(() => {
    if (session && session.kind === 'migrate') noteMigration(session.sessionId);
    else if (gone) forgetMigration();
  }, [session, gone, shownId]);
  // Before the not-found line paints, so the page that asks elsewhere takes its place without a flash.
  useLayoutEffect(() => {
    if (gone && id && detail.error) onMissing?.(detail.error);
  }, [gone, id, detail.error, onMissing]);
  const bare = id ? null : bareTab(start, list, unchecked, shownId);
  if (bare) return bare;
  if (gone || (session && session.kind !== 'migrate'))
    return (
      <div className="empty tall">
        <Unshown at={`changes:${shownId ?? ''}`} />
        No migration {shownId}. <Link href={href.changeSession('migrate')}>Open Migrate</Link>
      </div>
    );
  if (detail.error && !session) return <ErrorState retry={detail.reload}>{failedRead(detail.error)}</ErrorState>;
  if (list.error && !sessions) return <ErrorState retry={list.reload}>{failedRead(list.error)}</ErrorState>;
  if (!session || !sessions) return <Skeleton what="this migration" lines={8} />;
  return <MigrateReport session={session} sessions={sessions} retiring={start.data?.retiring ?? []} use={start.data?.use ?? []} run={run} call={call} />;
}

/** What the bare tab shows before a migration's page: its reads' wait or failure, no goldens, a retiring model, or Switch from and To; null once it opens a migration. */
function bareTab(start: Loaded<MigrateStartView>, list: Loaded<DecisionsListView>, unchecked: MigrateRetiring | null, shownId: string | null): ReactNode {
  const error = start.error ?? list.error;
  if (error && (!start.data || !list.data)) return <ErrorState retry={start.data ? list.reload : start.reload}>{failedRead(error)}</ErrorState>;
  if (!start.data || !list.data) return <Skeleton what="Migrate" lines={8} />;
  if (!start.data.goldens) return <NoGoldens />;
  // Keyed by the model, so the next one to lead starts on its own replacement.
  if (unchecked) return <RetiringStart key={unchecked.model} n={unchecked} start={start.data} />;
  return shownId ? null : <SwitchStart use={start.data.use} />;
}

/** No golden to migrate: what to pack first, as Preview says it. */
function NoGoldens() {
  return (
    <EmptyState title="Switch models with the evidence" text={INTRO} copy>
      <p className="emptyline">
        {NO_GOLDENS} <Link href={href.runs()}>Open Runs</Link>
      </p>
    </EmptyState>
  );
}

/** Why Migrate to can't start on what the field holds; null when it can. */
const toWhy = (to: string, from: readonly string[]): string | null => (!to ? 'Name the model to switch to' : !MODEL_NAME.test(to) ? 'That isn’t a model’s name' : from.includes(to) ? 'Pick a model other than the one it switches from' : null);

/** The runs' own models for the field, the one switched from left out. */
const recordedOf = (use: readonly MigrateUse[], from: string) => use.filter((u) => u.model !== from).map((u) => ({ id: u.model, family: u.family }));

/** A retiring model: its date, who recommends what, its goldens and scopes, Switch to, the command and Migrate to, then where the date comes from. */
function RetiringStart({ n, start }: { n: MigrateRetiring; start: MigrateStartView }) {
  const [to, setTo] = useState(n.replacements[0] ?? '');
  const listing = useModelChoices();
  const s: MigrateSwitch = { from: [n.model], to, goldens: n.goldens };
  const who = n.owner ?? n.platformName;
  return (
    <section className="panel stepempty mgstart">
      <h2>{n.heading}</h2>
      <p>{inCode(n.facts)}</p>
      <div className="form one mgform">
        <ModelField label="Switch to" value={to} onChange={setTo} recorded={recordedOf(start.use, n.model)} listing={listing} recommended={n.replacements} />
      </div>
      <StartGo s={s} />
      <p className="muted mgsrc">
        {n.matched && n.matched !== n.model ? `${n.model} names the snapshot ${n.matched}. ` : ''}The date is from the retirement table that ships with Shadowlap, read from {who ? `${who}’s` : 'the provider’s'}{' '}
        <a className="dlink" href={n.source} target="_blank" rel="noreferrer">
          model deprecations
        </a>{' '}
        page; nothing is fetched.
      </p>
    </section>
  );
}

/** The command the choice makes, then Migrate to <model>, lime, waiting while the field holds no other model. */
function StartGo({ s }: { s: MigrateSwitch }) {
  return (
    <>
      <CodeBox command={migrateCommand(s)} className="mgcmd" />
      <div className="actions">
        <MigrateButton s={s} lime why={toWhy(s.to, s.from)} />
      </div>
    </>
  );
}

/** No model retiring and no migration yet: Switch from (the models in use, most used first) and To, the command following the choice. */
function SwitchStart({ use }: { use: readonly MigrateUse[] }) {
  const [from, setFrom] = useState(use[0]?.model ?? '');
  const [typed, setTo] = useState<string | null>(null);
  const listing = useModelChoices();
  // A From that equals To clears To, which falls back to the first other model the goldens call, else
  // the first other the providers list, of From's family where one is.
  const family = use.find((u) => u.model === from)?.family ?? null;
  const listed = (listing?.choices ?? []).filter((c) => c.id !== from);
  const to = typed !== null && typed !== from ? typed : (use.find((u) => u.model !== from)?.model ?? (listed.find((c) => c.family === family) ?? listed[0])?.id ?? '');
  const s: MigrateSwitch = { from: from ? [from] : [], to, goldens: [] };
  return (
    <section className="panel stepempty mgstart">
      <h2>Switch models with the evidence</h2>
      <p>{INTRO}</p>
      <div className="form mgform">
        <label>
          Switch from
          <select
            value={from}
            onChange={(e) => {
              setFrom(e.currentTarget.value);
              if (typed === e.currentTarget.value) setTo(null);
            }}
          >
            {use.map((u) => (
              <option key={u.model} value={u.model}>
                {u.model}
              </option>
            ))}
          </select>
        </label>
        <ModelField label="To" value={to} onChange={setTo} recorded={recordedOf(use, from)} listing={listing} />
      </div>
      <StartGo s={s} />
    </section>
  );
}
