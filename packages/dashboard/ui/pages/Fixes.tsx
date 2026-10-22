import { useEffect, useState } from 'react';
import { Badge, Chips, EmptyState, PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { rememberList } from '../fixes/data.js';
import { FixPage } from '../fixes/FixPage.js';
import { chipKeeps, failingLine, FIX_CHIPS, fixStamp, statusBadge, type FixChip } from '../fixes/model.js';
import { FailedMust } from '../fixes/parts.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import type { FixRow } from '../types.js';

/**
 * Fixes (#/fixes): one row per failure, from where it was lost to a fix that held. A fix
 * (#/fixes/<id>[/<step>[/<sub>]]) opens on its own page with its three steps.
 */
export function FixesPage({ id, step, sub }: { id: string | null; step: string | null; sub: string | null }) {
  return id ? <FixPage key={id} id={id} step={step} sub={sub} /> : <FixList />;
}

/** The command the empty page offers: blame names where a failed run was lost, and opens its fix. */
const BLAME = `shadowlap blame <run> --expect '{"tools":{"send_email":1}}'`;

/** The filter chip, kept while the page is open in this tab: back from a fix, the list is as it was left. */
let chipShown: FixChip = 'all';

function FixList() {
  const { client, tick, feeds, exported } = useApp();
  const [chip, setChipState] = useState<FixChip>(() => chipShown);
  const setChip = (c: FixChip) => {
    chipShown = c;
    setChipState(c);
  };
  // Again when runs change, or fixes do (a blame or repair in a terminal, a title set elsewhere).
  const loaded = useLoad(() => (exported ? null : client.fixes()), 'fixes', `${tick}:${feeds.fixes ?? 0}`);
  const list = loaded.data;
  useEffect(() => {
    if (list) rememberList(list);
  }, [list]);
  const header = <PageHeader eyebrow="blame · repair · verify" title="Fixes" text="Find the call that lost the run, fix it, and check the fix holds." />;
  if (loaded.error && !list)
    return (
      <Page>
        {header}
        <div className="empty">Could not load the fixes: {loaded.error.message}</div>
      </Page>
    );
  if (!list)
    return (
      <Page>
        {header}
        <div className="empty">{exported ? 'Fixes are not part of an exported copy.' : 'Loading the fixes…'}</div>
      </Page>
    );
  if (!list.counts.all)
    return (
      <Page>
        {header}
        <EmptyState title="No fixes here." text="A fix starts from a failed run: blame finds the model call where it was lost and opens a fix, repair proposes a change, and verify proves it holds." command={BLAME} />
      </Page>
    );
  const shown = list.fixes.filter((f) => chipKeeps(chip, f));
  const counts: Record<FixChip, number> = { all: list.counts.all, open: list.counts.open, verified: list.counts.verified };
  return (
    <Page>
      {header}
      <div className="tbar">
        <Chips label="Status" items={FIX_CHIPS.map((c) => ({ ...c, count: counts[c.key] }))} value={chip} onChange={setChip} />
      </div>
      <section className="panel">
        <div className="pslist">
          {shown.map((f) => (
            <FixListRow key={f.fixId} fix={f} />
          ))}
          {shown.length ? null : <div className="empty">No fixes here.</div>}
        </div>
      </section>
    </Page>
  );
}

function FixListRow({ fix: f }: { fix: FixRow }) {
  const badge = statusBadge(f);
  return (
    <a href={href.fixes(f.fixId)}>
      <Badge tone={badge.tone}>{badge.text}</Badge>
      <span className="pst">
        <span className="rt">{f.title}</span>
        <span className="rs">
          {f.label ? <span className="chip">{f.label}</span> : null}
          {f.source ? <span className="chip ci">{f.source}</span> : null}
          <span className="nw">{failingLine(f)}</span>
          {f.broken ? <span className="fxbad">doesn’t hold: {f.broken}</span> : null}
        </span>
        <FailedMust fix={f} />
      </span>
      <span className="psteps">
        {f.steps.map((st) => (
          <span key={st.key} className={st.state}>
            <i />
            {st.short}
          </span>
        ))}
      </span>
      <span className="rd">{fixStamp(f.openedAt)}</span>
    </a>
  );
}
