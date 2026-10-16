/**
 * Settings' tabs and their addresses (`#/settings/<key>`), shared by the page and the breadcrumb.
 * CI keeps the address Alerts had; `#/settings/ci` opens it too, and is replaced by that address.
 */

export type SettingsTab = 'matching' | 'redaction' | 'alerts' | 'agents' | 'tools' | 'project' | 'store';

/** In order, as the page lists them. */
export const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: 'matching', label: 'Matching' },
  { key: 'redaction', label: 'Redaction' },
  { key: 'alerts', label: 'CI' },
  { key: 'agents', label: 'Coding agents' },
  { key: 'tools', label: 'Tools' },
  { key: 'project', label: 'Project' },
  { key: 'store', label: 'Store' },
];

/** The tab an address opens: Matching without one, CI for `ci`, null for one that isn't a tab. */
export function settingsTab(tab: string | null | undefined): SettingsTab | null {
  if (!tab) return 'matching';
  if (tab === 'ci') return 'alerts';
  return SETTINGS_TABS.some((t) => t.key === tab) ? (tab as SettingsTab) : null;
}

/** What the breadcrumb calls the tab an address opens. */
export function settingsTabLabel(tab: string | null | undefined): string {
  const key = settingsTab(tab) ?? 'matching';
  return SETTINGS_TABS.find((t) => t.key === key)!.label;
}
