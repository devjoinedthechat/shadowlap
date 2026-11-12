import { useEffect } from 'react';
import { PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { useActiveTabInView } from '../hooks.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';
import { ProblemHeader } from './Setup.js';
import { AgentsTab } from './settings/Agents.js';
import { CiTab } from './settings/Ci.js';
import './settings/jobs.js';
import { SETTINGS_TABS, settingsTab, type SettingsTab } from './settings/logic.js';
import { MatchingTab } from './settings/Matching.js';
import { ProjectTab } from './settings/Project.js';
import { RedactionTab } from './settings/Redaction.js';
import { StoreTab } from './settings/Store.js';
import { ToolsTab } from './settings/Tools.js';

/**
 * Settings (`#/settings/<tab>`): how this project records, replays and shares, most of it kept in
 * shadowlap.config.json beside its code, one tab per address. Matching, Redaction, CI
 * (`#/settings/ci`, still opened by `#/settings/alerts`), Coding agents, Tools, Project (still
 * opened by `#/settings/plan`) and Store. Nothing here needs a run, so it opens as it is in a project
 * with none. A project that can't be opened (its folder is gone) says so in its header, as every
 * other page does in its place, with Remove project…; its tabs turn their edits off (`useFolderGone`).
 */
export function SettingsPage({ tab }: { tab: string | null }) {
  const { meta } = useApp();
  const problem = meta?.project?.id && meta.project.problem ? meta.project : null;
  const current = settingsTab(tab);
  // A bare `#/settings` and an address that isn't a tab (a typo) open Matching at its own address,
  // so the address and the breadcrumb name the tab shown. An older name (`alerts`, `plan`) stays as
  // typed: it opens its tab.
  useEffect(() => {
    if (!tab || !current) navigate(href.settings(current ?? 'matching'), true);
  }, [current, tab]);
  const shown: SettingsTab = current ?? 'matching';
  const eyebrow = [projectOf(meta)?.name, 'project settings'].filter(Boolean).join(' · ');
  return (
    <Page>
      {problem ? <ProblemHeader id={problem.id!} name={problem.name} problem={problem.problem!} /> : <PageHeader eyebrow={eyebrow} title="Settings" text="How this project records, replays and shares." />}
      <nav className="stabs" aria-label="Settings" ref={useActiveTabInView<HTMLElement>(shown)}>
        {SETTINGS_TABS.map((t) => (
          <a key={t.key} href={href.settings(t.key)} aria-current={t.key === shown ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
      <div className="settab">
        <TabBody tab={shown} />
      </div>
    </Page>
  );
}

function TabBody({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case 'matching':
      return <MatchingTab />;
    case 'redaction':
      return <RedactionTab />;
    case 'ci':
      return <CiTab />;
    case 'agents':
      return <AgentsTab />;
    case 'tools':
      return <ToolsTab />;
    case 'project':
      return <ProjectTab />;
    case 'store':
      return <StoreTab />;
  }
}
