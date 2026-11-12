/**
 * Settings' tabs and their addresses (`#/settings/<key>`), shared by the page and the breadcrumb.
 * Two older names still open a tab, the address keeping what was typed: `#/settings/alerts` opens
 * CI and `#/settings/plan` opens Project. Every link goes to the tab's own key.
 */

export type SettingsTab = 'matching' | 'redaction' | 'ci' | 'agents' | 'tools' | 'project' | 'store';

/** In order, as the page lists them. */
export const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: 'matching', label: 'Matching' },
  { key: 'redaction', label: 'Redaction' },
  { key: 'ci', label: 'CI' },
  { key: 'agents', label: 'Coding agents' },
  { key: 'tools', label: 'Tools' },
  { key: 'project', label: 'Project' },
  { key: 'store', label: 'Store' },
];

const OLDER_NAMES: Readonly<Record<string, SettingsTab>> = { alerts: 'ci', plan: 'project' };

/** The tab an address opens: Matching without one, CI for `alerts`, Project for `plan`, null for one that isn't a tab. */
export function settingsTab(tab: string | null | undefined): SettingsTab | null {
  if (!tab) return 'matching';
  if (Object.hasOwn(OLDER_NAMES, tab)) return OLDER_NAMES[tab]!;
  return SETTINGS_TABS.some((t) => t.key === tab) ? (tab as SettingsTab) : null;
}

/** What the breadcrumb calls the tab an address opens. */
export function settingsTabLabel(tab: string | null | undefined): string {
  const key = settingsTab(tab) ?? 'matching';
  return SETTINGS_TABS.find((t) => t.key === key)!.label;
}
