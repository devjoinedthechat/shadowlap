import { CmdLine, PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { useApp } from '../state.js';
import { projectOf } from '../shell/ProjectBlock.js';

/**
 * Fixes (#/fixes, #/fixes/<id>[/<step>[/<sub>]]): one failure from where it was lost to a fix that
 * held. Not in the dashboard yet; until it is, the page says how to do it in the terminal.
 */
export function FixesPage({ id }: { id: string | null; step: string | null; sub: string | null }) {
  const { meta } = useApp();
  return (
    <Page>
      <PageHeader eyebrow={projectOf(meta)?.name ?? 'fixes'} title={id ? `Fix ${id}` : 'Fixes'} text="Each failure from where it was lost to a fix that held: blame finds the model call that lost the run, repair proposes a change, and verify proves it." />
      <section className="panel stepempty">
        <h3>Fixes run in the terminal for now</h3>
        <p>Blame a failing run with what a passing run must do, as the expect object of an outcome check (JSON, or @file); it names the model call where the run was lost.</p>
        <CmdLine>{`shadowlap blame <run> --expect '{"tools":{"send_email":0}}'`}</CmdLine>
      </section>
    </Page>
  );
}
