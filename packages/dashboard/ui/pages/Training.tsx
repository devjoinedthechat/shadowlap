import { CmdLine, PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';

/** Training (#/training, #/training/tasks). Not in the dashboard yet; the page says what works today. */
export function TrainingPage({ tab }: { tab: 'pairs' | 'tasks' }) {
  const { meta } = useApp();
  return (
    <Page>
      <PageHeader eyebrow={projectOf(meta)?.name ?? 'training'} title={tab === 'tasks' ? 'Training · Tasks' : 'Training · Pairs'} text="Answers that lost a run next to answers that passed, read from blame and verify attempts, and goldens as tasks a model can be scored on." />
      <section className="panel stepempty">
        <h3>Export what runs recorded</h3>
        <p>Today the conversations runs recorded export as an eval or fine-tuning dataset, by label or by run.</p>
        <CmdLine>shadowlap export dataset --label good --out good.jsonl</CmdLine>
      </section>
    </Page>
  );
}
