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
 * under the same head. A preview's and a migration's addresses open Verdicts, where their rows are,
 * until their tabs land.
 */

const PART = { waiting: <Skeleton what="this tab" lines={6} />, failed: <LoadFailed what="tab" /> };
const VerdictsTab = onShow(() => import('../changes/Verdicts.js').then((m) => m.VerdictsTab), PART);
const RevisionPage = onShow<{ rev: string }>(() => import('../changes/RevisionPage.js').then((m) => m.RevisionPage), PART);

export function ChangesPage({ tab, id }: { tab: ChangesTab; id: string | null }) {
  const session = tab !== 'verdicts';
  useEffect(() => {
    if (session) navigate(href.changes(), true);
  }, [session]);
  return (
    <Page>
      <ChangesHead tab="verdicts" />
      {session ? null : id ? <RevisionPage rev={id} /> : <VerdictsTab />}
    </Page>
  );
}
