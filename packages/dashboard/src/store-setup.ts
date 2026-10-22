import type { Store } from '@shadowlap/engine';
import {
  accessPolicy,
  CI_PROVIDERS,
  ciStep,
  CREDENTIAL_HINTS,
  credentialsHere,
  formatStoreUrl,
  lastCheck,
  parseStoreUrl,
  PROVIDER_NAMES,
  PROVIDERS,
  SCHEMES,
  shortStoreName,
  storeKey,
  storeKindName,
  type CiProvider,
  type CiStepKeys,
  type LastCheck,
  type PolicyPart,
  type Provider,
  type StoreLocation,
} from '@shadowlap/remote';
import { VERSION } from './ci-yaml.js';
import { nextSetupStep, type SetupFacts } from './store-steps.js';
import { countsOf, type TeamStoreInput } from './team-store.js';

/**
 * The team store's setup page (`#/setup/store`, reached from Settings → Store, the palette, and
 * Needs a look while it is under way): four steps that connect a bucket the team owns, the way the
 * CLI does it, each with its command. Connect your bucket (`store set <url> --check`), push your
 * runs (`push --all`), push from CI (the step `store ci` prints) and bring your team (commit the
 * config). The dashboard's setup of a store is kept with what this machine knows of that store
 * (team_sync's data, `setup`): when it started, what was said about CI, and when it was finished.
 * A store set with the CLI has no setup under way: Settings → Store shows the store as it is, and
 * the setup page the steps left. Nothing here makes a request: the CLI is what talks to the bucket.
 */

/** A store the setup can connect: its name, its scheme, an example, and whose credentials this machine would use. */
export interface SetupProvider {
  provider: Provider;
  name: string;
  scheme: string;
  /** An example to type over, with the shape the scheme wants. */
  example: string;
  /** What this machine would sign in with, found offline; null when nothing here names any. */
  credentials: { uses: string; from: string } | null;
  /** Where that provider's credentials come from, in words, for when none were found. */
  hint: { uses: string; from: string };
}

/** The access to ask a cloud admin for, as `shadowlap store policy` prints it. */
export interface SetupPolicy {
  writer: PolicyPart;
  pullRequest: PolicyPart;
  notes: string[];
  command: string;
}

/** One CI's step, as `shadowlap store ci --provider <ci>` prints it. */
export interface SetupCiStep {
  ci: CiProvider;
  name: string;
  file: string;
  text: string;
  oidc: boolean;
  notes: string[];
  command: string;
}

/** What the dashboard's setup of a store recorded. */
export interface SetupRecord {
  startedAt: number | null;
  /** Push from CI: the step was added, or skipped for now. */
  ci: 'added' | 'skipped' | null;
  /** The CI it was added for, which Settings → Store's Copy CI step copies afterwards. */
  ciProvider: CiProvider | null;
  finishedAt: number | null;
}

export interface StoreSetupView {
  /** The store the config names, when it is one. */
  store: { url: string; configured: string; key: string; name: string; provider: Provider; providerName: string } | null;
  /** The setup is under way: started from the setup page and not finished. Settings → Store, the palette and Needs a look lead back to it. */
  active: boolean;
  /** The step to do next, numbered from 1, or null once the four are done. */
  next: { step: number; title: string } | null;
  setup: SetupRecord;
  /** The steps done: the store is set and its last check worked, this machine pushed to it. */
  connected: boolean;
  pushed: boolean;
  check: LastCheck | null;
  /** Runs on this machine, by run: those a push would send (finished, only here), and those it pushed. */
  runs: { onlyLocal: number; pushedHere: number };
  providers: SetupProvider[];
  /** Each CI's step for the store, once there is one. */
  ci: SetupCiStep[] | null;
  /** The config change that brings the team in, and the command that commits it. */
  commit: { file: string; line: string; command: string } | null;
}

export const CONFIG_FILE = 'shadowlap.config.json';
const COMMIT = `git add ${CONFIG_FILE} && git commit -m "Use the team store"`;
const CI_NAMES: Record<CiProvider, string> = { github: 'GitHub Actions', gitlab: 'GitLab CI', other: 'Other' };
// Names to fill in, never one a reader could paste: a bucket's name is global, and a stranger may hold it.
const EXAMPLES: Record<Provider, string> = { s3: 's3://<bucket>/<project>', gcs: 'gs://<bucket>/<project>', azure: 'az://<account>/<container>/<project>', r2: 'r2://<account-id>/<bucket>/<project>' };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The setup recorded for a store, as team_sync's data keeps it. */
export function setupRecord(store: Store, key: string): SetupRecord {
  const raw = store.teamSync(key)?.data.setup;
  const s = isObject(raw) ? raw : {};
  return {
    startedAt: num(s.startedAt),
    ci: s.ci === 'added' || s.ci === 'skipped' ? s.ci : null,
    ciProvider: typeof s.ciProvider === 'string' && (CI_PROVIDERS as readonly string[]).includes(s.ciProvider) ? (s.ciProvider as CiProvider) : null,
    finishedAt: num(s.finishedAt),
  };
}

/** Records a step of the setup of a store: merged into what was recorded before. */
export function recordSetup(store: Store, key: string, patch: Partial<SetupRecord>): SetupRecord {
  store.setTeamSync(key, { data: { setup: { ...setupRecord(store, key), ...patch } } });
  return setupRecord(store, key);
}

function locationOf(raw: string | null): StoreLocation | null {
  if (!raw) return null;
  try {
    return parseStoreUrl(raw);
  } catch {
    return null;
  }
}

/** What the setup's steps go by: whether the store is connected and pushed to, what a push would send, CI, finished. */
function setupFacts(store: Store, key: string | null, setup: SetupRecord): SetupFacts & { check: LastCheck | null; pushedHere: number } {
  const counts = countsOf(store, key ?? '');
  const check = key ? lastCheck(store, key) : null;
  const sync = key ? store.teamSync(key) : null;
  return { connected: key !== null && check?.ok === true, pushed: !!sync?.pushedAt, onlyLocal: counts.onlyLocal, ci: setup.ci, finished: setup.finishedAt !== null, check, pushedHere: counts.pushedHere };
}

/**
 * The setup of the store the config names, when it is under way (started from the setup page and
 * not finished): its next step, which Needs a look leads to. Null otherwise, and for a store set
 * with the CLI, which has nothing under way.
 */
export function setupUnderWay(store: Store, input: TeamStoreInput): { step: number; title: string } | null {
  const loc = locationOf(input.store);
  if (!loc) return null;
  const key = storeKey(loc);
  const setup = setupRecord(store, key);
  if (setup.startedAt === null || setup.finishedAt !== null) return null;
  return nextSetupStep(setupFacts(store, key, setup));
}

/**
 * What the setup page shows: the providers, where the setup stands, the CI steps (with the keys the
 * goldens that run live need, `keys`, as `liveKeys` gives them) and the commit.
 */
export function storeSetupView(store: Store, input: TeamStoreInput, options: { env?: NodeJS.ProcessEnv; home?: string; keys?: CiStepKeys } = {}): StoreSetupView {
  const loc = locationOf(input.store);
  const key = loc ? storeKey(loc) : null;
  const setup: SetupRecord = key ? setupRecord(store, key) : { startedAt: null, ci: null, ciProvider: null, finishedAt: null };
  const facts = setupFacts(store, key, setup);
  const env = { ...(options.env ? { env: options.env } : {}), ...(options.home ? { home: options.home } : {}) };
  return {
    store: loc && key ? { url: loc.url, configured: formatStoreUrl(loc), key, name: shortStoreName(loc), provider: loc.provider, providerName: storeKindName(loc) } : null,
    active: !!loc && setup.startedAt !== null && setup.finishedAt === null,
    next: nextSetupStep(facts),
    setup,
    connected: facts.connected,
    pushed: facts.pushed,
    check: facts.check,
    runs: { onlyLocal: facts.onlyLocal, pushedHere: facts.pushedHere },
    providers: PROVIDERS.map((provider) => ({
      provider,
      name: PROVIDER_NAMES[provider],
      scheme: SCHEMES[provider],
      example: EXAMPLES[provider],
      credentials: credentialsHere(provider, loc && loc.provider === provider ? loc : null, env),
      hint: CREDENTIAL_HINTS[provider],
    })),
    ci: loc
      ? CI_PROVIDERS.map((ci) => {
          const step = ciStep(ci, loc, { version: VERSION, ...(options.keys ?? {}) });
          return { ci, name: CI_NAMES[ci], file: step.file, text: step.text, oidc: step.oidc, notes: step.notes, command: `shadowlap store ci --provider ${ci}` };
        })
      : null,
    commit: loc ? { file: CONFIG_FILE, line: `"store": ${JSON.stringify(input.store)}`, command: COMMIT } : null,
  };
}

/** A store URL typed in the setup, checked against the provider picked, with the access to ask for and whose credentials would open it. */
export type SetupUrlCheck =
  | { ok: true; provider: Provider; configured: string; url: string; name: string; credentials: { uses: string; from: string } | null; policy: SetupPolicy; command: string }
  | { ok: false; provider: Provider; error: string; policy: SetupPolicy };

function policyFor(provider: Provider, loc: StoreLocation | null): SetupPolicy {
  const p = accessPolicy(provider, loc);
  return { writer: p.writer, pullRequest: p.pullRequest, notes: p.notes, command: `shadowlap store policy --provider ${provider}` };
}

export function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);
}

/** Checks a URL the way `store set --provider <p>` does, before the setup runs it. */
export function checkSetupUrl(provider: Provider, raw: string, options: { env?: NodeJS.ProcessEnv; home?: string } = {}): SetupUrlCheck {
  let loc: StoreLocation;
  try {
    loc = parseStoreUrl(raw, provider);
  } catch (err) {
    return { ok: false, provider, error: err instanceof Error ? err.message : String(err), policy: policyFor(provider, null) };
  }
  const configured = formatStoreUrl(loc);
  const env = { ...(options.env ? { env: options.env } : {}), ...(options.home ? { home: options.home } : {}) };
  return {
    ok: true,
    provider,
    configured,
    url: loc.url,
    name: shortStoreName(loc),
    credentials: credentialsHere(provider, loc, env),
    policy: policyFor(provider, loc),
    command: setupCommand(configured, provider),
  };
}

/** The command Check access and connect runs, as a terminal would take it. */
export function setupCommand(configured: string, provider: Provider): string {
  const quoted = /^[\w@%+=:,./-]+$/.test(configured) ? configured : `'${configured.replace(/'/g, `'\\''`)}'`;
  return `shadowlap store set ${quoted} --provider ${provider} --check`;
}
