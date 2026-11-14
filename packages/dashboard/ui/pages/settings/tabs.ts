/**
 * Settings' tabs and their addresses (`#/settings/<key>`), shared by the page and the breadcrumb.
 * Two older names still open a tab, the address keeping what was typed: `#/settings/alerts` opens
 * CI and `#/settings/plan` opens Project. Every link goes to the tab's own key. Gates was CI's last
 * panel once, so the address a link to a gate's kind had then (`#/settings/ci?gate=<kind>`) goes on
 * to Gates (`olderGateLink`).
 */

export type SettingsTab = 'matching' | 'redaction' | 'ci' | 'gates' | 'agents' | 'tools' | 'project' | 'store';

/** In order, as the page lists them. */
export const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: 'matching', label: 'Matching' },
  { key: 'redaction', label: 'Redaction' },
  { key: 'ci', label: 'CI' },
  { key: 'gates', label: 'Gates' },
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

/** A gate's kind, as the engine names it: a fixed gate's `sprt`, a gate against history's `baseline`. */
export type GateKind = 'sprt' | 'baseline';

/** The kind an address asks Gates to open on (`#/settings/<tab>?gate=<kind>`), or null. */
export function gateLink(hash: string, tab: 'gates' | 'ci' = 'gates'): GateKind | null {
  const m = new RegExp(`^#/settings/${tab}\\?(?:.*&)?gate=(sprt|baseline)(?:&|$)`).exec(hash);
  return m ? (m[1] as GateKind) : null;
}

/** The kind a link from when Gates was CI's panel asks for (`#/settings/ci?gate=<kind>`), or null: it opens Gates on it. */
export const olderGateLink = (hash: string): GateKind | null => gateLink(hash, 'ci');

/** What the breadcrumb calls the tab an address opens. */
export function settingsTabLabel(tab: string | null | undefined): string {
  const key = settingsTab(tab) ?? 'matching';
  return SETTINGS_TABS.find((t) => t.key === key)!.label;
}
