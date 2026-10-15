import { CmdLine, PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { SETTINGS_TABS } from '../shell/TopBar.js';
import { useApp } from '../state.js';

/** Settings (#/settings/<tab>): the project's config. Not in the dashboard yet; the page says how to change it. */
export function SettingsPage({ tab }: { tab: string | null }) {
  const { meta } = useApp();
  const name = tab ? (SETTINGS_TABS[tab] ?? tab) : null;
  return (
    <Page>
      <PageHeader eyebrow={projectOf(meta)?.name ?? 'settings'} title={name ? `Settings · ${name}` : 'Settings'} text="Normalizers, the date-matching clock, redaction rules and tool effects, kept in shadowlap.config.json beside your code." />
      <section className="panel stepempty">
        <h3>Change them in the terminal for now</h3>
        <p>Calibrate replays a recording until it is clean and writes the normalizers it needs; redaction rules apply to every copy that leaves the machine.</p>
        <CmdLine>{'shadowlap calibrate <run> --write'}</CmdLine>
      </section>
    </Page>
  );
}
