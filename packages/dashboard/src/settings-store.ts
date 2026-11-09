import { CONFIG_FILE, messageOf, readRules } from '@shadowlap/engine';
import { accessPolicy, parseStoreUrl, policyLines, type StoreLocation } from '@shadowlap/remote';
import { teamStoreStatus, type TeamStoreInput, type TeamStoreStatus } from './team-store.js';
import { type ConfigInfo, loadConfigFile, type SettingsContext } from './settings-shared.js';

/** Settings' Store tab: where the store is, and the team store it pushes to. */

export interface StoreSettings {
  /** The config, for the version an edit (Push from CI) sends back. */
  config: ConfigInfo;
  /** `store` as shadowlap.config.json has it; null when it names none ("No store yet"). */
  configured: string | null;
  /** Why the configured store can't be used: not a bucket URL, or a config that can't be read. */
  error: string | null;
  /** The bucket, the last sync, runs in the store and only here, the last check, your access, Push from CI. */
  status: TeamStoreStatus | null;
  /** "Copy access policy": what `shadowlap store policy` prints for the store's cloud, `#` lines and all. */
  policy: { text: string; command: string } | null;
  /**
   * The redaction rules a share link's report applies (every rule, always): how many, or null when
   * they can't be read (the file, or a rule in it), so a share stops until they can.
   */
  redactRules: number | null;
}

/**
 * Settings → Store, the team store: what `shadowlap store show` says, offline, and the access
 * policy to copy. GitHub's CI step is Settings → CI's, in Your workflow; the setup's steps for
 * GitLab CI and other CI are `GET /api/store/setup`'s. Push, pull and Check again are jobs; Push from CI is a config edit. Nothing here
 * reaches the bucket.
 */
export function storeSettings(ctx: Pick<SettingsContext, 'store' | 'cwd'>, input: TeamStoreInput): StoreSettings {
  const { info, file } = loadConfigFile(ctx.cwd);
  const rules = file && !info.error && (file.data.redact === undefined || Array.isArray(file.data.redact)) ? readRules(file, 'redact') : null;
  const redactRules = rules && !rules.some((r) => r.error) ? rules.length : null;
  const configured = input.store;
  if (!configured) return { config: info, configured: null, error: info.error, status: null, policy: null, redactRules };
  let loc: StoreLocation;
  try {
    loc = parseStoreUrl(configured);
  } catch (err) {
    return { config: info, configured, error: `${CONFIG_FILE} names a store that can't be used: ${messageOf(err)}`, status: null, policy: null, redactRules };
  }
  const policy = { text: policyLines(accessPolicy(loc.provider, loc)).map((l) => l.text).join('\n'), command: 'shadowlap store policy' };
  return { config: info, configured, error: info.error, status: teamStoreStatus(ctx.store, input), policy, redactRules };
}
