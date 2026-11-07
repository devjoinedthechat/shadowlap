import { useEffect } from 'react';
import { ChangesHead } from '../changes/Head.js';
import { LoadFailed } from '../components/bits.js';
import { onShow } from '../components/OnShow.js';
import { Page } from '../components/Page.js';
import { Skeleton } from '../components/States.js';
import { href, type ChangesTab } from '../route.js';
import { navigate } from '../router.js';

/**
 * Changes: what a change does to your agent, on its own recorded runs. Its head stands on every tab
 * while a tab's own script comes: Verdicts and a revision's page each wait for one (`onShow`), so
 * opening Changes loads neither until it shows. Compare is a page of its own (pages/Compare.tsx),
 * under the same head. Preview, a preview at its run and call, is a part too. A migration's address
 * opens Verdicts, where its row is, until its tab lands.
 */

const PART = { waiting: <Skeleton what="this tab" lines={6} />, failed: <LoadFailed what="tab" /> };
const VerdictsTab = onShow(() => import('../changes/Verdicts.js').then((m) => m.VerdictsTab), PART);
const RevisionPage = onShow<{ rev: string }>(() => import('../changes/RevisionPage.js').then((m) => m.RevisionPage), PART);
const PreviewTab = onShow<{ id: string | null; run: string | null; call: number | null }>(() => import('../changes/Preview.js').then((m) => m.PreviewTab), PART);

export function ChangesPage({ tab, id, run, call }: { tab: ChangesTab; id: string | null; run?: string | undefined; call?: number | undefined }) {
  const migration = tab === 'migrate';
  useEffect(() => {
    if (migration) navigate(href.changes(), true);
  }, [migration]);
  if (tab === 'decisions')
    return (
      <Page>
        <ChangesHead tab="decisions" />
        <PreviewTab id={id} run={run ?? null} call={call ?? null} />
      </Page>
    );
  return (
    <Page>
      <ChangesHead tab="verdicts" />
      {migration ? null : id ? <RevisionPage rev={id} /> : <VerdictsTab />}
    </Page>
  );
}
