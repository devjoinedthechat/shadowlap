import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isReservedScope, type CallRecord, type StoreOf } from '@shadowlap/engine';
import { hostedProviders, providers as routed, type Provider } from '@shadowlap/sidecar';

/** Every provider whose SDKs take a key from the environment, the hosts of another's format among them (Claude on Foundry). */
const providers: readonly Provider[] = [...routed, ...hostedProviders];

/**
 * Placeholder keys for a replay's agent, and the note a run keeps of the keys its environment held.
 *
 * A model client built the default way (`new Anthropic()`, `new OpenAI()`, Google's client) takes its
 * key from the environment and fails before it sends anything when there is none, even on a replay
 * that the recording answers in full. With a placeholder it sends its requests, and the recording
 * answers them. The sidecar refuses any live call that would carry one (placeholders.ts in the
 * sidecar), so a placeholder never goes anywhere. None replaces a credential the environment holds,
 * of any kind the provider's SDKs read: a key, a token, a profile, an identity, a shared file.
 *
 * - An offline replay (`shadowlap test`, unless `--online` or the golden may fork; recorded tests;
 *   `bisect` without `--fork`; `calibrate`; `coverage --pack`; `decisions --from-code`) gets one for
 *   each provider its recording called. Nothing it does goes live.
 * - `shadowlap replay`, which goes live from a fork, gets one only for a provider whose key the
 *   recording's own environment held (`RunMeta.keyEnv`): its agent took the key from the environment
 *   then. An agent that brought its own key (a .env file it loads, a local server's dummy key), signed
 *   in another way (a token provider, an instance role) or ran where nothing says (an import, a run
 *   made before runs kept the note) gets none, so a fork goes live with what the agent has.
 * - A provider marked `onlyWhereRecorded` (Azure OpenAI) gets one only where the recording's
 *   environment held its key, in every replay: a client that signs in with a token provider refuses
 *   a key beside it.
 * - What forks on purpose to run live (blame, verify and repair attempts, `--chaos`, `test --update`,
 *   a golden that may fork) gets none: a live call needs the real key.
 */

type Env = NodeJS.ProcessEnv;

const held = (env: Env, name: string) => !!env[name]?.trim();

/**
 * The folders the Anthropic SDKs look for a profile in: ANTHROPIC_CONFIG_DIR, else on Windows
 * `%APPDATA%\Anthropic`, elsewhere `$XDG_CONFIG_HOME/anthropic` (the TypeScript SDK) and
 * `~/.config/anthropic` (both).
 */
function anthropicConfigDirs(env: Env, home: string): string[] {
  const set = env.ANTHROPIC_CONFIG_DIR?.trim();
  if (set) return [set];
  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim() || (env.USERPROFILE?.trim() ? join(env.USERPROFILE.trim(), 'AppData', 'Roaming') : '');
    return appData ? [join(appData, 'Anthropic')] : [];
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return [...(xdg ? [join(xdg, 'anthropic')] : []), join(home, '.config', 'anthropic')];
}

/**
 * An Anthropic profile the SDKs would sign in with when the environment holds no key: the active
 * profile's config, `configs/<name>.json`, where `active_config` names it, or `default`.
 */
function anthropicProfile(env: Env, home: string): boolean {
  return anthropicConfigDirs(env, home).some((root) => {
    let profile = 'default';
    try {
      profile = readFileSync(join(root, 'active_config'), 'utf8').trim() || 'default';
    } catch {
      // no active profile named: the default one
    }
    return /^[\w.-]+$/.test(profile) && existsSync(join(root, 'configs', `${profile}.json`));
  });
}

/**
 * The settings in an AWS shared file that give a profile credentials, one of them each way the AWS
 * SDKs sign in from one: keys, a process, IAM Identity Center (SSO), a role to assume, web identity,
 * `aws login`. A profile with none of them, a region alone, gives none.
 */
const AWS_CREDENTIAL_SETTINGS = new Set(['aws_access_key_id', 'credential_process', 'sso_session', 'sso_start_url', 'role_arn', 'credential_source', 'web_identity_token_file', 'login_session']);

/** The settings of each section of an INI file, as AWS's shared files are: `[name]`, then `key = value` lines. */
function iniSections(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let section: Set<string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([^\]]*?)\s*\]/.exec(line);
    if (header) {
      const name = header[1]!.replace(/\s+/g, ' ');
      section = out.get(name) ?? new Set();
      out.set(name, section);
      continue;
    }
    const setting = /^([^=\s]+)\s*=/.exec(line);
    if (setting && section) section.add(setting[1]!.toLowerCase());
  }
  return out;
}

/**
 * Credentials the AWS SDKs would read from the shared files for the profile they use: the
 * credentials file's `[name]` or the config file's `[profile name]` (`[default]` for the default),
 * where the profile is AWS_DEFAULT_PROFILE's (boto3 reads it) or `default`. A file that is there
 * with no credentials in that profile, as a config file that names only a region, gives none.
 * AWS_PROFILE names a profile the SDKs fail without, so it counts itself.
 */
function awsProfileCredentials(env: Env, home: string): boolean {
  const named = env.AWS_DEFAULT_PROFILE?.trim();
  const profiles = [...new Set([...(named ? [named] : []), 'default'])];
  const read = (file: string): Map<string, Set<string>> => {
    try {
      return iniSections(readFileSync(file, 'utf8'));
    } catch {
      return new Map();
    }
  };
  const credentials = read(env.AWS_SHARED_CREDENTIALS_FILE?.trim() || join(home, '.aws', 'credentials'));
  const config = read(env.AWS_CONFIG_FILE?.trim() || join(home, '.aws', 'config'));
  const holds = (settings: Set<string> | undefined) => [...(settings ?? [])].some((s) => AWS_CREDENTIAL_SETTINGS.has(s));
  return profiles.some((p) => holds(credentials.get(p)) || holds(config.get(`profile ${p}`)) || (p === 'default' && holds(config.get('default'))));
}

/**
 * Whether the environment holds a credential the provider's SDKs would use, of any kind: a variable
 * they read, set and not empty (a CI secret a pull request from a fork doesn't get is empty), or the
 * files they read when there is none. For AWS (Bedrock, and OpenAI's SDK on Bedrock) that is a
 * profile in the shared files that holds credentials, never a file being there: a config file that
 * names a region is no credential, and a client that reads its key from the environment fails
 * without one. Claude on Foundry and Azure OpenAI read their key, or the token provider the code
 * gives them, never an Azure CLI sign-in.
 */
export function hasCredentials(provider: Provider, env: Env, home = homedir()): boolean {
  if (!provider.keys) return false;
  if (provider.keys.credentials.some((name) => held(env, name))) return true;
  if (provider.id === 'bedrock' || provider.id === 'bedrock-mantle') return awsProfileCredentials(env, home);
  if (provider.id === 'anthropic') return anthropicProfile(env, home);
  return false;
}

/**
 * The providers whose credentials the environment holds, each with the placeholder variables that
 * hold its key (none for a credential of another kind): what a run keeps as `RunMeta.keyEnv`. Names
 * only, never a value.
 */
export function keyEnvOf(env: Env, home = homedir()): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of providers) {
    if (!p.keys || !hasCredentials(p, env, home)) continue;
    out[p.id] = Object.keys(p.keys.placeholders).filter((name) => held(env, name));
  }
  return out;
}

/** A recording's note as it can be trusted: a pack's run says what it likes, so only providers and variables shadowlap knows count. */
export function keyEnvNote(value: unknown): Record<string, string[]> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, string[]> = {};
  for (const p of providers) {
    const names = (value as Record<string, unknown>)[p.id];
    if (!p.keys || !Array.isArray(names)) continue;
    out[p.id] = names.filter((n): n is string => typeof n === 'string' && Object.hasOwn(p.keys!.placeholders, n));
  }
  return out;
}

/**
 * The placeholders a replay's agent gets, by variable: for each provider the recording's agent called
 * whose credentials the environment lacks. `offline` for a replay where nothing goes live; `replay`
 * for `shadowlap replay`, which gives them only for the providers whose key the recording's note
 * names. A provider whose calls reach the sidecar only by in-process capture (Azure OpenAI, Bedrock)
 * gets none when capture is off, since its calls would then go straight to the provider. Gemini's go
 * into the variable the recording's environment held its key in, when the note says, so Google's
 * SDKs don't warn that both are set; an `onlyWhereRecorded` provider's only ever there (Azure's
 * AZURE_OPENAI_API_KEY for the OpenAI SDKs, AZURE_API_KEY for the AI SDK and LiteLLM), so a client
 * signing in another way finds no key beside it that it never had.
 */
export function placeholderKeys(env: Env, recording: { calls: readonly Pick<CallRecord, 'meta'>[]; keyEnv?: unknown }, mode: 'offline' | 'replay', home = homedir()): Record<string, string> {
  // A call through a host of another's format (Claude on Foundry) takes that host's key, not the format's.
  const used = new Set(recording.calls.filter((c) => !isReservedScope(c.meta.scope)).map((c) => c.meta.via ?? c.meta.provider));
  const note = keyEnvNote(recording.keyEnv);
  const out: Record<string, string> = {};
  for (const p of providers) {
    if (!p.keys || !used.has(p.id) || hasCredentials(p, env, home)) continue;
    if (!p.upstream && env.SHADOWLAP_CAPTURE === 'off') continue;
    const names = note?.[p.id];
    if (mode === 'replay' && !names) continue;
    if (p.keys.onlyWhereRecorded && !Object.keys(p.keys.placeholders).some((name) => names?.includes(name))) continue;
    const alternatives = (p.id === 'gemini' || p.keys.onlyWhereRecorded) && names?.length ? names : Object.keys(p.keys.placeholders);
    for (const name of alternatives) out[name] = p.keys.placeholders[name]!;
  }
  return out;
}

/** Placeholders for a replay of `parent`, from its calls and note in `store`. */
export function placeholdersFor(store: StoreOf<'recording'>, parent: { runId: string; meta?: { keyEnv?: unknown } | null }, mode: 'offline' | 'replay', env: Env = process.env): Record<string, string> {
  return placeholderKeys(env, { calls: store.getCalls(parent.runId), keyEnv: parent.meta?.keyEnv }, mode);
}

/**
 * What a run keeps of the providers whose credentials the environment held as its agent started
 * (`keyEnv`), as a patch of its metadata: a replay of `parentRunId` adds its recording's note, since
 * an agent that ran on placeholders took its key from the environment all the same. Nothing when it
 * can't be read: the run is what matters.
 */
export function keyEnvPatch(store: StoreOf<'recording'>, parentRunId: string | null, env: Env = process.env): { keyEnv?: Record<string, string[]> } {
  try {
    const note = keyEnvOf(env);
    const recorded = parentRunId ? keyEnvNote(store.getRun(parentRunId)?.meta?.keyEnv) : null;
    for (const [id, names] of Object.entries(recorded ?? {})) note[id] = [...new Set([...(note[id] ?? []), ...names])];
    return { keyEnv: note };
  } catch {
    return {};
  }
}

/**
 * Keeps on a run the providers whose credentials the environment held as its agent started
 * (`keyEnv`). A replay adds its recording's note: an agent that ran on placeholders took its key
 * from the environment all the same. Never throws: the run is what matters.
 */
export function stampKeyEnv(store: StoreOf<'recording'>, runId: string, env: Env = process.env): void {
  try {
    const patch = keyEnvPatch(store, store.getRun(runId)?.parentRunId ?? null, env);
    if (patch.keyEnv) store.updateRunMeta(runId, patch);
  } catch {
    // a run without the note replays with the keys of its environment
  }
}
