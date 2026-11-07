import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { links, liveKeys } from '@shadowlap/dashboard';
import { ciProvider, ConfigConflictError, ConfigFileError, editConfigFile, messageOf, plural, recordEvent, repairMarkdown, resolveAuthor, safeText, Store, type StoreOf, teamRunCounts, ulid, type RunRecord } from '@shadowlap/engine';
import {
  accessPolicy,
  checkStore,
  ciStep,
  formatStoreUrl,
  isPrecondition,
  keys as storeKeys,
  lastCheck,
  openObjectStore,
  parseStoreUrl,
  policyLines,
  pull,
  pullRequestFolders,
  pullRequestJob,
  pullRequestLocation,
  push,
  queuedRuns,
  recordCheck,
  shareReport,
  SHARE_DAYS,
  storeKey,
  attemptOfRun,
  LayoutError,
  StoreError,
  StoreUrlError,
  storeKindName,
  teamRunInStore,
  type CheckStepName,
  type CiProvider,
  type LastCheck,
  type ObjectStore,
  type OpenOptions,
  type Provider,
  type PullResult,
  type PushResult,
  type StoreCheck,
  type StoreLocation,
} from '@shadowlap/remote';
import { specFor, type TestEntry } from './checks.js';
import { CONFIG_FILE, configPath, defaultDbPath, loadConfig, loadTests, type ShadowlapConfig } from './config.js';
import { expandRecordings, goldenMode, goldenName } from './goldens.js';
import { emitJobEvent, inDashboardJob } from './job-events.js';
import type { TestReport } from './test-report.js';
import { linkInPath } from './real-path.js';
import { palette as p, safe, shortId } from './ui.js';
import { ancestorsOf, stillRecording, VERSION } from './shared.js';

/**
 * The team store: the project's runs in a bucket the team owns, free like the rest of Shadowlap.
 * Every command here works the same way: the project's config names the store, and this machine's
 * own credentials open it. Nothing calls home, and there are no accounts: who may read and write
 * the store is whoever the cloud admin gives access to (`shadowlap store policy`).
 *
 * A pull request's CI job runs whatever the pull request says, so whatever it writes goes to the
 * pull request's own folder in the store (pr/<number>/), which a pull leaves out unless asked.
 *
 * Each command is a function taking a TeamEnv, so the tests run it in process with a fake bucket
 * and a fixed clock; the CLI passes the defaults.
 */

export interface TeamIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface TeamEnv {
  cwd: string;
  /** The project's store file (`--db`, or `.shadowlap/shadowlap.db`). */
  dbPath: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Passed to the bucket drivers: a fetch, a home folder, a retry delay (tests). */
  open?: Omit<OpenOptions, 'env' | 'now'>;
  /** Reads a CI event payload (GITHUB_EVENT_PATH); tests pass their own. */
  readFile?: (path: string) => string;
  io: TeamIo;
}

export function teamEnv(db: string | undefined, io: Partial<TeamIo> = {}): TeamEnv {
  const cwd = process.cwd();
  return {
    cwd,
    dbPath: resolve(db ?? defaultDbPath(cwd)),
    env: process.env,
    now: () => Date.now(),
    io: { out: io.out ?? ((t) => void process.stdout.write(t)), err: io.err ?? ((t) => void process.stderr.write(t)) },
  };
}

/** A failure the command explains in words; the CLI prints the message and exits 1. */
export class TeamError extends Error {
  /** `cause`: the store's own error it says in words, which decides the command's exit status. */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TeamError';
  }
}

function line(t: TeamEnv, text = ''): void {
  t.io.out(`${text}\n`);
}

function note(t: TeamEnv, text: string): void {
  t.io.err(`${text}\n`);
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function config(t: TeamEnv): ShadowlapConfig {
  return loadConfig(t.cwd);
}

/** The store the project's config names, or null when none is set. */
export function configuredStore(t: TeamEnv): StoreLocation | null {
  const url = config(t).store;
  if (!url) return null;
  try {
    return parseStoreUrl(url);
  } catch (err) {
    throw new TeamError(`${CONFIG_FILE}: ${messageOf(err)}`);
  }
}

export function requireStore(t: TeamEnv): StoreLocation {
  const loc = configuredStore(t);
  if (!loc) throw new TeamError(`No team store is set for this project. Set one with: shadowlap store set s3://<bucket>/<folder> (or gs://, az://, r2://)`);
  return loc;
}

export function openRemote(t: TeamEnv, loc: StoreLocation): ObjectStore {
  return openObjectStore(loc, { env: t.env, now: t.now, ...(t.open ?? {}) });
}

function actor(t: TeamEnv): string | null {
  return resolveAuthor({ env: t.env, cwd: t.cwd });
}

function withStore<T>(t: TeamEnv, fn: (store: Store) => T): T {
  const store = Store.open(t.dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/**
 * Writes one key into shadowlap.config.json as every other edit of it does (the engine's
 * config-file): under its lock, so an edit from the dashboard's Settings at the same moment isn't
 * lost, in one atomic replace, and with every other key, the indentation and the line endings as
 * the user wrote them.
 */
function setConfigKey(cwd: string, key: string, value: unknown): void {
  try {
    editConfigFile(cwd, {}, (data) => {
      data[key] = value;
    });
  } catch (err) {
    if (err instanceof ConfigFileError || err instanceof ConfigConflictError) throw new TeamError(err.message);
    throw err;
  }
}

/** Where this machine writes: the store's folder, or in a pull request's CI job, that pull request's own. */
export interface WriteTarget {
  loc: StoreLocation;
  /** The pull request's number, in a pull request's job. */
  pr: string | null;
  /** How the pull request's job was recognised, in words. */
  source: string | null;
}

/**
 * Where a command run here writes in the store. In a pull request's CI job that is the pull
 * request's own folder, pr/<number>/: whatever a pull request's job writes stays out of the runs the
 * team pulls, and the pull-request policy keeps its credentials from writing anywhere else. A pull
 * request's job whose number can't be found writes nothing.
 */
export function writeTarget(t: TeamEnv, loc: StoreLocation): WriteTarget {
  const job = pullRequestJob(t.env, t.readFile ? { readFile: t.readFile } : {});
  if (!job) return { loc, pr: null, source: null };
  if (!job.number) {
    const why = job.source === 'SHADOWLAP_PR' ? `SHADOWLAP_PR is "${t.env.SHADOWLAP_PR ?? ''}", which isn't a pull request's number` : `This is a pull request's CI job, ${job.source}, and its number couldn't be found`;
    throw new TeamError(`${why}, so nothing goes to the store: a pull request's job writes only to its own folder, pr/<number>/. Set SHADOWLAP_PR to the pull request's number.`);
  }
  return { loc: pullRequestLocation(loc, job.number), pr: job.number, source: job.source };
}

function pullRequestLine(target: WriteTarget): string {
  return `${target.source!}: its runs go to pull request ${target.pr!}'s own folder in the store, which a pull brings only with --include-pr`;
}

// ---------------------------------------------------------------------------------------------- store setup

function setLocation(url: string, provider: Provider | undefined): StoreLocation {
  try {
    return parseStoreUrl(url, provider);
  } catch (err) {
    throw new TeamError(messageOf(err));
  }
}

/**
 * Writes the store to the config and says so; `check` is the check that went before, with --check,
 * as `store check --json` prints it. The JSON says `set`: true, as the config was written.
 */
function writeStore(t: TeamEnv, loc: StoreLocation, flags: { json?: boolean }, check: (StoreCheck & { pullRequest: string | null }) | null): number {
  const value = formatStoreUrl(loc);
  const previous = config(t).store ?? null;
  setConfigKey(t.cwd, 'store', value);
  withStore(t, (store) => recordEvent(store, { kind: 'store.set', actor: actor(t), ref: loc.url, data: { provider: loc.provider, previous } }));
  const result = { store: value, url: loc.url, provider: loc.provider, bucket: loc.bucket, prefix: loc.prefix, account: loc.account ?? null, region: loc.region ?? null, previous, config: configPath(t.cwd), set: true, ...(check ? { check } : {}) };
  emitJobEvent({ type: 'result', data: result }, t.env);
  if (flags.json) {
    line(t, JSON.stringify(result, null, 2));
    return 0;
  }
  line(t, `${p.green('✓')} Store set: ${value} ${p.dim(`(${storeKindName(loc)}${loc.region ? `, ${loc.region}` : ''})`)}`);
  line(t, p.dim(`  wrote "store" to ${CONFIG_FILE}${previous && previous !== value ? `, replacing ${previous}` : ''}. Credentials never go there: each machine uses its own.`));
  line(t, p.dim(`  Next: ${check ? 'shadowlap push --all' : 'shadowlap store check'}, then commit ${CONFIG_FILE} so the team uses the same store:`));
  line(t, p.dim(`    git add ${CONFIG_FILE} && git commit -m "Use the team store"`));
  return 0;
}

export function storeSet(t: TeamEnv, url: string, flags: { provider?: Provider; json?: boolean } = {}): number {
  return writeStore(t, setLocation(url, flags.provider), flags, null);
}

/**
 * `store set <url> --check`: checks the store with this machine's credentials first (list, write,
 * read and delete a test object; encryption, versioning and object lock), and writes it to the
 * config only when that works, so a store that can't be used never reaches the commit that brings
 * the team in. Settings → Store's "Check access and connect" runs it.
 */
export async function storeSetChecked(t: TeamEnv, url: string, flags: { provider?: Provider; json?: boolean } = {}): Promise<number> {
  const loc = setLocation(url, flags.provider);
  const { check, target } = await checkAt(t, loc, flags);
  if (check.ok) return writeStore(t, loc, flags, { ...check, pullRequest: target.pr });
  const result = { store: formatStoreUrl(loc), url: loc.url, provider: loc.provider, set: false, check: { ...check, pullRequest: target.pr } };
  emitJobEvent({ type: 'result', data: result }, t.env);
  if (flags.json) line(t, JSON.stringify(result, null, 2));
  else note(t, p.red(`✗ ${checkFailure(target.loc, check.failure, { unset: loc, dashboard: inDashboardJob(t.env) })} Nothing was written to ${CONFIG_FILE}.`));
  return 1;
}

/**
 * Settings → Store's "Push from CI": writes `ciPush` to shadowlap.config.json. Off, `test --push`
 * in CI runs the tests and keeps their runs in the job, and the GitHub Action keeps the fixes it
 * opens there; on (the default), both are pushed.
 */
export function storePushFromCi(t: TeamEnv, value: 'on' | 'off', flags: { json?: boolean } = {}): number {
  const on = value === 'on';
  const previous = config(t).ciPush ?? true;
  setConfigKey(t.cwd, 'ciPush', on);
  let ref: string | null = null;
  try {
    ref = configuredStore(t)?.url ?? null;
  } catch {
    ref = null;
  }
  withStore(t, (store) => recordEvent(store, { kind: 'store.ci', actor: actor(t), ...(ref ? { ref } : {}), data: { push: on, previous } }));
  const result = { ciPush: on, previous, config: configPath(t.cwd) };
  emitJobEvent({ type: 'result', data: result }, t.env);
  if (flags.json) {
    line(t, JSON.stringify(result, null, 2));
    return 0;
  }
  line(t, `${p.green('✓')} Push from CI ${on ? 'on' : 'off'}: shadowlap test --push in CI ${on ? 'pushes every test run and its report, and the GitHub Action each fix it opens' : 'runs the tests and keeps their runs in the job, and the GitHub Action keeps the fixes it opens there'}.`);
  line(t, p.dim(`  wrote "ciPush": ${on} to ${CONFIG_FILE}; commit it for CI to see it.`));
  return 0;
}

const STEP_WORDS: Record<CheckStepName, string> = { list: 'list', write: 'write', read: 'read', delete: 'delete' };

/**
 * Checks a store with this machine's credentials: where it writes (in a pull request's job, its own
 * folder), the steps and what the bucket keeps, recorded as the store's last check and in Activity.
 * Prints the steps unless asked for JSON.
 */
async function checkAt(t: TeamEnv, loc: StoreLocation, flags: { json?: boolean }): Promise<{ check: StoreCheck; target: WriteTarget }> {
  const target = writeTarget(t, loc);
  const remote = openRemote(t, target.loc);
  if (!flags.json) {
    line(t, `Checking ${target.loc.url} ${p.dim(`(${storeKindName(loc)})`)}`);
    if (target.pr) note(t, p.dim(`  ${pullRequestLine(target)}`));
  }
  const check: StoreCheck = await checkStore(remote, { now: t.now });
  const last: LastCheck = { ok: check.ok, at: t.now(), encryption: check.encryption, versioning: check.versioning, objectLock: check.objectLock.state, credentials: check.credentials };
  withStore(t, (store) => {
    recordCheck(store, storeKey(target.loc), last);
    recordEvent(store, { kind: 'store.checked', actor: actor(t), ref: target.loc.url, data: { ok: check.ok, versioning: check.versioning, objectLock: check.objectLock.state, encryption: check.encryption } });
  });
  if (!flags.json) {
    line(t, p.dim(`  credentials: ${check.credentials ?? 'none found'}`));
    for (const s of check.steps) line(t, `  ${s.ok ? p.green('✓') : p.red('✗')} ${STEP_WORDS[s.name]}${s.detail ? p.dim(`  ${safe(s.detail)}`) : ''}`);
    line(t, `  Encryption   ${check.encryption ?? p.yellow('not reported')}`);
    line(t, `  Versioning   ${check.versioning}`);
    line(t, `  Object lock  ${check.objectLock.state}${check.objectLock.detail ? p.dim(` (${safe(check.objectLock.detail)})`) : ''}`);
    for (const w of check.warnings) note(t, p.yellow(`! ${w}`));
    for (const n of check.notes) note(t, p.dim(`  ${n}`));
  }
  return { check, target };
}

export async function storeCheck(t: TeamEnv, flags: { json?: boolean } = {}): Promise<number> {
  const loc = requireStore(t);
  const { check, target } = await checkAt(t, loc, flags);
  const result = { ...check, pullRequest: target.pr };
  emitJobEvent({ type: 'result', data: result }, t.env);
  if (flags.json) {
    line(t, JSON.stringify(result, null, 2));
    return check.ok ? 0 : 1;
  }
  if (!check.ok) {
    note(t, p.red(`✗ ${checkFailure(target.loc, check.failure)}`));
    return 1;
  }
  line(t, `${p.green('✓')} The store works: list, write, read and delete.`);
  line(t, p.dim('  Next: shadowlap push --all'));
  return 0;
}

/** A word as a shell takes it: quoted when it holds anything but letters, digits and `@%+=:,./-`. */
const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * What a failed store check means, and what to do next, by the kind of its first failure. After
 * `store check`, the store is the config's; after `store set --check` (`unset`, the store asked
 * for), nothing was set, so the next step is that command again, or in a dashboard job, the
 * setup's Check access and connect.
 */
function checkFailure(loc: StoreLocation, failure: StoreCheck['failure'], o: { unset?: StoreLocation; dashboard?: boolean } = {}): string {
  const asked = o.unset ?? null;
  const again = !asked ? 'run shadowlap store check again' : o.dashboard ? 'Check access and connect again' : `run shadowlap store set ${shellWord(formatStoreUrl(asked))} --check again`;
  const policy = asked ? `shadowlap store policy --provider ${asked.provider}` : 'shadowlap store policy';
  switch (failure) {
    case 'network':
      return `Couldn't reach ${loc.url}: check the address${loc.endpoint ? ` (${loc.endpoint})` : ''} and this machine's network, then ${again}.`;
    case 'credentials':
      return `The credentials on this machine don't work for ${loc.url} (see the first step above). Sign in, or set the right keys, the way the cloud's own tools find them; then ${again}.`;
    case 'no-bucket':
      return asked ? `${loc.url} names a bucket these credentials can't find. Check the name, then ${again}.` : `${loc.url} names a bucket these credentials can't find. Check the name, then set it again with shadowlap store set <url>.`;
    case 'denied':
      return `These credentials can't use ${loc.url} yet. Ask your cloud admin for the access ${asked && o.dashboard ? 'this step shows' : `${policy} prints`}, then ${again}.`;
    default:
      return `${loc.url} didn't work with these credentials: see the steps above. If it is access, ask your cloud admin for what ${policy} prints${asked ? `; then ${again}` : ''}.`;
  }
}

export function storePolicy(t: TeamEnv, flags: { provider?: Provider; json?: boolean } = {}): number {
  let loc: StoreLocation | null;
  try {
    loc = configuredStore(t);
  } catch {
    loc = null;
  }
  const provider = flags.provider ?? loc?.provider;
  if (!provider) throw new TeamError('Name the cloud with --provider s3|gcs|azure|r2, or set the store first (shadowlap store set <url>).');
  const policy = accessPolicy(provider, loc);
  if (flags.json) {
    line(t, JSON.stringify(policy, null, 2));
    return 0;
  }
  // The same lines Settings → Store's Copy access policy copies.
  for (const l of policyLines(policy)) {
    if (l.comment) note(t, p.dim(l.text));
    else line(t, l.text);
  }
  return 0;
}

/**
 * The goldens a CI step's packs name (`goldens/*`), with how the config tests each, as Tests lists
 * them: which run live, and so which providers' keys the step needs. A config that can't be read
 * leaves out how they are tested; a pattern that can't be expanded names none.
 */
function goldensOf(cwd: string, packs: string): Array<ReturnType<typeof goldenMode> & { path: string }> {
  let entries: TestEntry[] = [];
  try {
    entries = loadTests(cwd);
  } catch {
    // the config being edited: the packs alone
  }
  let dirs: string[];
  try {
    dirs = expandRecordings(packs.split(/\s+/).filter(Boolean), cwd).dirs;
  } catch {
    return [];
  }
  return dirs.map((d) => ({ path: goldenName(d, cwd), ...goldenMode(specFor(entries, resolve(cwd, d), cwd)) }));
}

export function storeCi(t: TeamEnv, flags: { provider: CiProvider; packs?: string; json?: boolean }): number {
  const loc = requireStore(t);
  const packs = flags.packs ?? 'goldens/*';
  // The tests run by this CLI's own release, as the Action's step pins it, with the keys of the
  // providers the goldens that run live call.
  const step = ciStep(flags.provider, loc, { version: VERSION, packs, ...liveKeys(t.cwd, goldensOf(t.cwd, packs)) });
  if (flags.json) {
    line(t, JSON.stringify(step, null, 2));
    return 0;
  }
  note(t, p.dim(`# ${step.file}${step.oidc ? ' · short-lived credentials (OIDC), no stored keys' : ''}`));
  line(t, step.text);
  for (const n of step.notes) note(t, p.dim(`# ${n}`));
  return 0;
}

/** What this machine knows about the store, offline: no request is made. */
export interface StoreStatus {
  url: string;
  store: string;
  provider: Provider;
  providerName: string;
  bucket: string;
  prefix: string;
  region: string | null;
  pushedAt: number | null;
  pulledAt: number | null;
  /** Runs in the store, as far as this machine knows (its pushes and the index it last read); attempts filed under their run. */
  inStore: number;
  /** Runs here with something not in the store: the run, or attempts filed under it. */
  onlyLocal: number;
  /** Attempts only here, filed under runs here. */
  localAttempts: number;
  /** Runs queued while recording, pushed when they end. */
  queued: number;
  /** The last `shadowlap store check` here. */
  check: LastCheck | null;
}

export function storeStatus(store: StoreOf<'recording' | 'readModels' | 'team'>, loc: StoreLocation, value: string): StoreStatus {
  const key = storeKey(loc);
  const sync = store.teamSync(key);
  const counts = teamRunCounts(store, key, 0);
  return {
    url: loc.url,
    store: value,
    provider: loc.provider,
    providerName: storeKindName(loc),
    bucket: loc.bucket,
    prefix: loc.prefix,
    region: loc.region ?? null,
    pushedAt: sync?.pushedAt ?? null,
    pulledAt: sync?.pulledAt ?? null,
    inStore: counts.inStore,
    onlyLocal: counts.onlyLocal,
    localAttempts: counts.localAttempts,
    queued: counts.queued,
    check: lastCheck(store, key),
  };
}

export function storeShow(t: TeamEnv, flags: { json?: boolean } = {}): number {
  const loc = configuredStore(t);
  if (!loc) {
    if (flags.json) line(t, JSON.stringify({ store: null }, null, 2));
    else line(t, `No store yet ${p.dim('· runs stay on this machine. A team store keeps them in a bucket you own: shadowlap store set s3://<bucket>/<folder>')}`);
    return 0;
  }
  const status = withStore(t, (store) => storeStatus(store, loc, config(t).store!));
  if (flags.json) {
    line(t, JSON.stringify(status, null, 2));
    return 0;
  }
  const when = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never');
  line(t, `Store     ${status.store} ${p.dim(`(${status.providerName}${status.region ? `, ${status.region}` : ''})`)}`);
  line(t, `Pushed    ${when(status.pushedAt)}`);
  line(t, `Pulled    ${when(status.pulledAt)}`);
  line(t, `Runs      ${status.inStore} in the store · ${status.onlyLocal} only on this machine${status.queued ? ` · ${status.queued} still recording, pushed when they end` : ''}`);
  if (status.onlyLocal) line(t, p.dim('  shadowlap push --all sends the ones only here; shadowlap pull brings the team\'s'));
  const c = status.check;
  line(t, `Checked   ${c ? `${when(c.at)} · ${c.ok ? 'works' : 'failed'} · versioning ${c.versioning} · object lock ${c.objectLock}` : `never ${p.dim('· shadowlap store check')}`}`);
  return 0;
}

// ---------------------------------------------------------------------------------------------- push, pull, share

function runList(store: StoreOf<'recording'>, args: string[]): string[] {
  return args.map((arg) => {
    const run = store.findRun(arg);
    if (!run) throw new TeamError(`no run matches "${arg}" (see: shadowlap ls)`);
    return run.runId;
  });
}

/**
 * Runs among these ids and the attempts filed under runs (`--repeat`, blame's probes, verify's
 * attempts), told apart as the Runs page tells them: a push or a pull says how many runs it moved,
 * with their attempts, so its numbers read like every screen's.
 */
function byRun(store: StoreOf<'recording'>, ids: readonly string[]): { runs: number; attempts: number } {
  let attempts = 0;
  for (const id of ids) {
    const run = store.getRun(id);
    const under = run ? attemptOfRun(store, run) : null;
    if (under && store.getRun(under)) attempts++;
  }
  return { runs: ids.length - attempts, attempts };
}

/** "45 runs", "45 runs and 69 attempts": what a push or a pull moved, by run. */
function runsAnd(n: { runs: number; attempts: number }): string {
  return `${plural(n.runs, 'run')}${n.attempts ? ` and ${plural(n.attempts, 'attempt')}` : ''}`;
}

/** The runs a pull brought, their attempts counted apart, and the runs by who made them. */
function pulledRuns(store: StoreOf<'recording'>, ids: readonly string[]): { runs: string[]; attempts: number; byAuthor: Record<string, number> } {
  const runs: string[] = [];
  const byAuthor: Record<string, number> = {};
  let attempts = 0;
  for (const id of ids) {
    const run = store.getRun(id);
    const under = run ? attemptOfRun(store, run) : null;
    if (under && store.getRun(under)) {
      attempts++;
      continue;
    }
    runs.push(id);
    const who = run?.meta?.author ?? 'unknown';
    byAuthor[who] = (byAuthor[who] ?? 0) + 1;
  }
  return { runs, attempts, byAuthor };
}

/** Runs only on this machine, and in the store, by run: what store show, push and pull say. */
function runCounts(store: StoreOf<'recording' | 'readModels'>, loc: StoreLocation): { inStore: number; onlyLocal: number } {
  const c = teamRunCounts(store, storeKey(loc), 0);
  return { inStore: c.inStore, onlyLocal: c.onlyLocal };
}

/** A store or bucket-layout failure, in words, as a TeamError: the command prints it without a stack. */
function asTeamError(err: unknown, hint?: string): unknown {
  if (err instanceof StoreError || err instanceof LayoutError || err instanceof StoreUrlError) return new TeamError(hint ? `${err.message}\n${hint}` : err.message, { cause: err });
  return err;
}

function problemLines(t: TeamEnv, head: string, problems: ReadonlyArray<{ runId: string; reason: string }>): void {
  note(t, p.yellow(`! ${head}`));
  for (const x of problems) note(t, p.yellow(`  ${shortId(x.runId)}  ${safe(x.reason)}`));
}

export async function teamPush(t: TeamEnv, runArgs: string[], flags: { all?: boolean; json?: boolean } = {}): Promise<number> {
  if (!runArgs.length && !flags.all) throw new TeamError('Name the runs to push, or push every run on this machine with --all.');
  const loc = requireStore(t);
  const target = writeTarget(t, loc);
  const remote = openRemote(t, target.loc);
  const store = Store.open(t.dbPath);
  let result: PushResult;
  let left: number;
  let moved: Moved;
  let fixTitles: Map<string, string>;
  let repairFiles: string[];
  try {
    const runIds = runList(store, runArgs);
    const who = actor(t);
    // A run whose recorder is gone (killed, out of memory) would wait for an end that never comes:
    // ended as interrupted at its last call, as gc ends it, it goes now.
    const named = new Set(runIds);
    for (const { run, lastAt } of store.recordingRuns().abandoned) if (flags.all || named.has(run.runId)) store.endRun(run.runId, 'crashed', lastAt);
    if (!flags.json) {
      note(t, p.dim(`Pushing to ${target.loc.url} as ${safe(who ?? 'an unknown author')} with ${safe(await remote.credentials().catch(() => 'no credentials'))}`));
      if (target.pr) note(t, p.dim(`  ${pullRequestLine(target)}`));
    }
    try {
      result = await push({ store, remote, actor: who, ci: ciProvider(t.env), pullRequest: target.pr, now: t.now, ...(flags.json ? {} : { log: (l: string) => note(t, p.dim(`  ${safe(l)}`)) }) }, { runIds, ...(flags.all ? { all: true } : {}) });
    } catch (err) {
      throw asTeamError(err, 'The runs that went up before it are in the store, listed for the team; push again to send the rest.');
    }
    left = runCounts(store, target.loc).onlyLocal;
    moved = movedByRun(store, result);
    fixTitles = new Map(result.fixes.sent.map((id) => [id, store.getFix(id)?.title ?? id]));
    recordEvent(store, { kind: 'store.pushed', actor: who, ref: target.loc.url, data: pushedEvent(result, moved, target.pr ? { pullRequest: target.pr } : {}) });
    // A teammate's repair the store's copy of a fix brought, beside the project as a pull writes it.
    repairFiles = writeRepairFiles(t, store, result.fixes.repairs);
  } finally {
    store.close();
  }
  const out = { store: target.loc.url, pullRequest: target.pr, ...result, onlyLocal: left };
  emitJobEvent({ type: 'result', data: out }, t.env);
  if (result.pushed.length || result.updated.length || result.repaired.length) emitJobEvent({ type: 'link', label: 'Open Runs', href: links.runs() }, t.env);
  // Runs that were named and can't go: the command didn't do what it was asked.
  const code = runArgs.length && result.refused.length ? 1 : 0;
  if (flags.json) {
    line(t, JSON.stringify(out, null, 2));
    return code;
  }
  const parts = [`${runsAnd(moved.pushed)} pushed`];
  if (result.updated.length) parts.push(`${runsAnd(moved.updated)} updated ${p.dim('(labels, notes, results)')}`);
  if (result.unchanged.length) parts.push(`${runsAnd(moved.unchanged)} already there`);
  if (result.repaired.length) parts.push(`${result.repaired.length} mended ${p.dim('(parts the store had lost, sent again)')}`);
  line(t, `${p.green('✓')} ${parts.join(', ')} · ${plural(result.blobs.uploaded, 'blob')} uploaded (${bytes(result.blobs.bytes)})${result.blobs.present ? `, ${result.blobs.present} already in the store` : ''}`);
  if (result.queued.length) line(t, p.dim(`  ${runsAnd(moved.queued)} still recording: ${result.queued.length === 1 ? 'it goes' : 'they go'} when ${result.queued.length === 1 ? 'it ends' : 'they end'} (${result.queued.map((id) => shortId(id)).join(', ')})`));
  if (result.refused.length) problemLines(t, `${plural(result.refused.length, 'run')} stayed on this machine:`, result.refused);
  fixLines(t, 'sent', result.fixes.sent, fixTitles, result.fixes.failed, "couldn't go to the store; the next push tries again");
  if (repairFiles.length) line(t, p.dim(`  teammates' repairs that came with them, their patches and reports: ${repairFiles.join(', ')}`));
  return code;
}

type Moved = Record<'pushed' | 'updated' | 'unchanged' | 'queued', { runs: number; attempts: number }>;

/** What a push moved, by run: the attempts filed under runs are counted apart, as every screen counts them. */
function movedByRun(store: StoreOf<'recording'>, result: PushResult): Moved {
  return { pushed: byRun(store, result.pushed), updated: byRun(store, result.updated), unchanged: byRun(store, result.unchanged), queued: byRun(store, result.queued) };
}

/** A push as Activity keeps it: runs, their attempts apart, and the fixes that went with them. */
function pushedEvent(result: PushResult, moved: Moved, extra: Record<string, unknown>): Record<string, unknown> {
  return { pushed: moved.pushed.runs, updated: moved.updated.runs, attempts: moved.pushed.attempts + moved.updated.attempts, repaired: result.repaired.length, queued: moved.queued.runs, refused: result.refused.length, blobs: result.blobs.uploaded, bytes: result.blobs.bytes, fixes: result.fixes.sent.length, ...extra };
}

/** What a push or a pull did with fixes: each by its title, and the ones that couldn't go or come. */
function fixLines(t: TeamEnv, verb: string, ids: readonly string[], titles: ReadonlyMap<string, string>, failed: ReadonlyArray<{ fixId: string; reason: string }>, why: string): void {
  if (ids.length) {
    const named = ids.slice(0, 3).map((id) => `"${safe(titles.get(id) ?? id)}"`);
    line(t, p.dim(`  ${plural(ids.length, 'fix', 'fixes')} ${verb}: ${named.join(', ')}${ids.length > 3 ? ` and ${ids.length - 3} more` : ''}`));
  }
  if (failed.length) {
    note(t, p.yellow(`! ${plural(failed.length, 'fix', 'fixes')} ${why}:`));
    for (const f of failed) note(t, p.yellow(`  ${f.fixId}  ${safe(f.reason)}`));
  }
}

/** What `pull --include-pr` brought from one pull request's folder. */
export interface PullRequestPull {
  number: string;
  url: string;
  pulled: string[];
  failed: PullResult['failed'];
  missing: string[];
  skippedSegments: PullResult['skippedSegments'];
  blobs: PullResult['blobs'];
  byAuthor: Record<string, number>;
}

export async function teamPull(t: TeamEnv, runArgs: string[], flags: { json?: boolean; includePr?: boolean } = {}): Promise<number> {
  const loc = requireStore(t);
  const remote = openRemote(t, loc);
  const store = Store.open(t.dbPath);
  let result: PullResult;
  let left: { inStore: number; onlyLocal: number };
  let got: { runs: string[]; attempts: number; byAuthor: Record<string, number> };
  let fixTitles: Map<string, string>;
  let repairFiles: string[];
  const prs: PullRequestPull[] = [];
  try {
    const log = flags.json ? {} : { log: (l: string) => note(t, p.dim(`  ${safe(l)}`)) };
    if (!flags.json) note(t, p.dim(`Pulling from ${loc.url} with ${safe(await remote.credentials().catch(() => 'no credentials'))}`));
    try {
      result = await pull({ store, remote, actor: actor(t), now: t.now, ...log }, { runIds: runArgs });
      // The store's own runs first: a run in both comes from there, never from a pull request's copy,
      // even as the ancestor of a pull request's run. Named runs are looked for in pull requests'
      // folders only when the store's own runs lack them.
      if (flags.includePr && (!runArgs.length || result.unknown.length)) {
        const main = result;
        const own = new Set(store.teamRuns(storeKey(loc)).filter(teamRunInStore).map((r) => r.runId));
        const fetchExcluded = async (runIds: string[]) => {
          const r = await pull({ store, remote, actor: actor(t), now: t.now, ...log }, { runIds });
          main.pulled.push(...r.pulled);
          main.failed.push(...r.failed);
          main.missing.push(...r.missing);
          main.blobs.downloaded += r.blobs.downloaded;
          main.blobs.bytes += r.blobs.bytes;
          for (const [who, n] of Object.entries(r.byAuthor)) main.byAuthor[who] = (main.byAuthor[who] ?? 0) + n;
        };
        let unknown = result.unknown;
        for (const number of await pullRequestFolders(remote)) {
          if (runArgs.length && !unknown.length) break;
          const folder = pullRequestLocation(loc, number);
          if (!flags.json) note(t, p.dim(`Pulling pull request ${number}'s runs from ${folder.url}`));
          const r = await pull({ store, remote: openRemote(t, folder), actor: actor(t), pullRequest: number, now: t.now, ...log }, { runIds: runArgs.length ? unknown : [], exclude: own, fetchExcluded });
          if (runArgs.length) unknown = r.unknown;
          prs.push({ number, url: folder.url, pulled: r.pulled, failed: r.failed, missing: r.missing, skippedSegments: r.skippedSegments, blobs: r.blobs, byAuthor: r.byAuthor });
        }
        result.unknown = unknown;
      }
    } catch (err) {
      throw asTeamError(err);
    }
    left = runCounts(store, loc);
    got = pulledRuns(store, result.pulled);
    recordEvent(store, {
      kind: 'store.pulled',
      actor: actor(t),
      ref: loc.url,
      // By run, as Activity says it: the attempts filed under them are counted apart.
      data: { pulled: got.runs.length, attempts: got.attempts, merged: result.merged.length, failed: result.failed.length, byAuthor: got.byAuthor, fixes: result.fixes.pulled.length + result.fixes.merged.length, ...(flags.includePr ? { pullRequests: prs.map((x) => ({ number: x.number, pulled: x.pulled.length })) } : {}) },
    });
    fixTitles = new Map([...result.fixes.pulled, ...result.fixes.merged].map((id) => [id, store.getFix(id)?.title ?? id]));
    // A teammate's repair, beside the project as on the machine that ran it: its patch and reports,
    // so Copy git apply and Apply the patch work here too.
    repairFiles = writeRepairFiles(t, store, result.fixes.repairs);
  } finally {
    store.close();
  }
  // The runs it brought, for the dashboard's drawer to open; their attempts are reached through them.
  for (const runId of [...got.runs, ...prs.flatMap((x) => x.pulled)]) emitJobEvent({ type: 'run', runId, role: 'imported' }, t.env);
  // Counted by run, as every screen counts them: attempts are filed under their run.
  const out = { store: loc.url, ...result, inStore: left.inStore, onlyLocal: left.onlyLocal, pullRequests: prs };
  emitJobEvent({ type: 'result', data: out }, t.env);
  // Names that match nothing, or named runs that couldn't come: the command didn't do what it was asked.
  const failed = result.failed.length + prs.reduce((n, x) => n + x.failed.length, 0);
  const code = result.unknown.length || (runArgs.length && failed) ? 1 : 0;
  if (flags.json) {
    line(t, JSON.stringify(out, null, 2));
    return code;
  }
  const by = Object.entries(got.byAuthor)
    .sort((a, b) => b[1] - a[1])
    .map(([who, n]) => `${safe(who.includes('@') ? who.split('@')[0]! : who)} ${n}`);
  line(t, `${p.green('✓')} ${runsAnd({ runs: got.runs.length, attempts: got.attempts })} pulled${by.length ? ` ${p.dim(`(${by.join(', ')})`)}` : ''}${result.blobs.downloaded ? ` · ${plural(result.blobs.downloaded, 'blob')} (${bytes(result.blobs.bytes)})` : ''}${result.merged.length ? ` · ${plural(result.merged.length, "run's labels and notes", "runs' labels and notes")} merged` : ''}`);
  line(t, p.dim(`  The store has ${plural(left.inStore, 'run')}; ${left.onlyLocal} only on this machine${left.onlyLocal ? ' (shadowlap push --all sends them)' : ''}.`));
  if (result.needPush.length) line(t, p.dim(`  ${plural(result.needPush.length, 'run')} here ${result.needPush.length === 1 ? 'has' : 'have'} changes the store doesn't: the next push sends them.`));
  if (result.skippedDeleted.length) line(t, p.dim(`  ${plural(result.skippedDeleted.length, 'run')} deleted on this machine stay deleted; name one to pull it again.`));
  if (result.missing.length) note(t, p.yellow(`! ${plural(result.missing.length, 'run')} listed in the store ${result.missing.length === 1 ? 'is' : 'are'} gone from it, deleted there: ${result.missing.map((id) => shortId(id)).join(', ')}`));
  if (result.failed.length) problemLines(t, `${plural(result.failed.length, 'run')} in the store couldn't be pulled; the next pull tries again:`, result.failed);
  for (const s of result.skippedSegments) note(t, p.yellow(`! Skipped ${safe(s.key)} in the store's index: ${safe(s.reason)}`));
  if (flags.includePr) {
    const pulled = prs.filter((x) => x.pulled.length);
    const count = pulled.reduce((n, x) => n + x.pulled.length, 0);
    line(t, `${p.green('✓')} ${plural(count, 'run')} from pull requests pulled${pulled.length ? ` ${p.dim(`(${pulled.map((x) => `#${x.number} ${x.pulled.length}`).join(', ')})`)}` : ''}`);
    if (count) line(t, p.dim("  They stay on this machine: a push never takes a pull request's runs into the store's own."));
    for (const x of prs) {
      if (x.failed.length) problemLines(t, `${plural(x.failed.length, 'run')} in pull request ${x.number}'s folder couldn't be pulled:`, x.failed);
      for (const s of x.skippedSegments) note(t, p.yellow(`! Skipped ${safe(s.key)} in pull request ${x.number}'s index: ${safe(s.reason)}`));
    }
  }
  fixLines(t, 'pulled', result.fixes.pulled, fixTitles, result.fixes.failed, "in the store couldn't be read; the next pull tries again");
  fixLines(t, 'merged', result.fixes.merged, fixTitles, [], '');
  if (repairFiles.length) line(t, p.dim(`  their repairs' patches and reports: ${repairFiles.join(', ')}`));
  for (const name of result.unknown) note(t, p.red(`✗ No run in the store matches "${safe(name)}" (or more than one does).`));
  return code;
}

/**
 * Writes the files of repairs a pull brought beside the project, as the repair wrote them where it
 * ran: `fix.patch`, `report.json` and `report.md` in `.shadowlap/repairs/<id>/`, so `shadowlap fix
 * apply` and the Fixes page's Copy git apply find the patch here. Never into a folder that is there
 * already, nor through a link on the way to it, which a repository can track (`.shadowlap/repairs`)
 * to send the files wherever it points. The recordings a repair made of the fixed runs (its goldens)
 * aren't among them: a golden runs the command it recorded when it is tested, so it comes from the
 * repository, never the store.
 */
function writeRepairFiles(t: TeamEnv, store: StoreOf<'fixes'>, repairIds: readonly string[]): string[] {
  const written: string[] = [];
  for (const id of repairIds) {
    const r = store.getRepair(id);
    if (!r || !/^repair-[0-9a-z]{1,40}$/.test(r.repairId) || r.dir !== `.shadowlap/repairs/${r.repairId}`) continue;
    const link = linkInPath(t.cwd, r.dir);
    if (link) {
      note(t, p.yellow(`! couldn't write ${r.dir}: ${link} in ${t.cwd} is a link, which Shadowlap never writes through: make it a folder of its own`));
      continue;
    }
    const dir = join(t.cwd, '.shadowlap', 'repairs', r.repairId);
    if (existsSync(dir)) continue;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (r.report.patch) writeFileSync(join(dir, 'fix.patch'), r.report.patch);
      writeFileSync(join(dir, 'report.json'), JSON.stringify(r.report, null, 2) + '\n');
      writeFileSync(join(dir, 'report.md'), repairMarkdown(r.report));
      written.push(r.dir);
    } catch (err) {
      note(t, p.yellow(`! couldn't write ${r.dir}: ${safe(messageOf(err))}`));
    }
  }
  return written;
}

export async function teamShare(t: TeamEnv, runArg: string, flags: { lineage?: boolean; json?: boolean; version?: string; uiDir?: string } = {}): Promise<number> {
  const loc = requireStore(t);
  // The run first: a name that matches nothing says so before anything is asked of the store.
  const found = withStore(t, (store) => store.findRun(runArg));
  if (!found) throw new TeamError(`no run matches "${safe(runArg)}" (see: shadowlap ls)`);
  const run: RunRecord = found;
  // A report of a run still recording would show it recording for good: shared once it has ended, as pack and the exports copy it.
  const recording = withStore(t, (store) => stillRecording(store, run, 'share', flags.lineage ? ancestorsOf(store, run) : []));
  if (recording) throw new TeamError(recording);
  const target = writeTarget(t, loc);
  const remote = openRemote(t, target.loc);
  const cfg = config(t);
  const { exportHtml, withAncestors } = await import('@shadowlap/dashboard');
  const store = Store.open(t.dbPath);
  let html: string;
  let included: string[];
  let redacted: boolean;
  try {
    const ids = flags.lineage ? withAncestors(store, run.runId) : [run.runId];
    // Every redaction rule applies: the link opens for anyone who has it.
    const result = exportHtml({
      store,
      runIds: flags.lineage ? [run.runId, ...ids.filter((id: string) => id !== run.runId)] : ids,
      version: flags.version ?? null,
      ...(cfg.prices ? { prices: cfg.prices } : {}),
      ...(cfg.redact.length ? { redact: cfg.redact } : {}),
      ...(flags.uiDir ? { uiDir: flags.uiDir } : {}),
    });
    html = result.html;
    included = result.runIds;
    redacted = result.redacted;
  } finally {
    store.close();
  }
  let share: Awaited<ReturnType<typeof shareReport>>;
  try {
    share = await shareReport(remote, run.runId, html);
  } catch (err) {
    throw asTeamError(err);
  }
  withStore(t, (s) => recordEvent(s, { kind: 'run.shared', actor: actor(t), runId: run.runId, ref: share.key, data: { expiresAt: share.link.expiresAt, redacted, runs: included.length, ...(target.pr ? { pullRequest: target.pr } : {}) } }));
  const out = { runId: run.runId, url: share.link.url, expiresAt: share.link.expiresAt, note: share.link.note, store: target.loc.url, key: share.key, bytes: share.bytes, redacted, rules: cfg.redact.length, runs: included };
  emitJobEvent({ type: 'result', data: out }, t.env);
  if (flags.json) {
    line(t, JSON.stringify(out, null, 2));
    return 0;
  }
  note(t, `${p.green('✓')} Shared ${shortId(run.runId)}: a ${redacted ? 'redacted ' : ''}report in ${target.loc.url}, ${bytes(share.bytes)} · the link works until ${new Date(share.link.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC (${SHARE_DAYS} days at most)`);
  if (!redacted) note(t, p.yellow(`! No redaction rules in ${CONFIG_FILE}: the report holds the prompts and tool data as recorded. Add rules with shadowlap redact add before sharing more.`));
  else note(t, p.dim(`  ${plural(cfg.redact.length, 'redaction rule')} applied; anyone with the link can open it, without an account`));
  if (share.link.note) note(t, p.yellow(`! ${share.link.note}`));
  line(t, share.link.url);
  return 0;
}

// ---------------------------------------------------------------------------------------------- after a run, and in CI

/**
 * Runs someone asked to push while they were still recording go to the store once they have ended.
 * Every command that ends runs calls this when it is done (run, replay, serve, blame, verify). It
 * reads only this machine's store unless a queued run is ready, and is quiet unless it pushes.
 */
export async function pushIfQueued(t: TeamEnv): Promise<void> {
  let target: WriteTarget;
  try {
    const loc = configuredStore(t);
    if (!loc) return;
    // Queued where the push that queued them would have written: the same process, the same job.
    target = writeTarget(t, loc);
  } catch {
    return;
  }
  const url = target.loc.url;
  let ready: string[];
  try {
    ready = withStore(t, (store) => queuedRuns(store, storeKey(target.loc)).ready);
  } catch {
    return;
  }
  if (!ready.length) return;
  const which = ready.length === 1 ? `${shortId(ready[0]!)} was` : `${plural(ready.length, 'run')} were`;
  try {
    const remote = openRemote(t, target.loc);
    const store = Store.open(t.dbPath);
    try {
      const result = await push({ store, remote, actor: actor(t), ci: ciProvider(t.env), pullRequest: target.pr, now: t.now }, { runIds: [] });
      for (const id of [...result.pushed, ...result.updated]) if (ready.includes(id)) note(t, p.dim(`[shadowlap] pushed ${shortId(id)} to ${url}, as asked while it was recording`));
      for (const r of result.refused) note(t, p.yellow(`! ${shortId(r.runId)} was queued for the store, but it stays here: ${safe(r.reason)}`));
      // By run, as a push from the command line records it; `queued: true` says it waited for the run to end.
      recordEvent(store, { kind: 'store.pushed', actor: actor(t), ref: url, data: pushedEvent(result, movedByRun(store, result), { queued: true, ...(target.pr ? { pullRequest: target.pr } : {}) }) });
      writeRepairFiles(t, store, result.fixes.repairs);
    } finally {
      store.close();
    }
  } catch (err) {
    note(t, p.yellow(`! ${which} queued for the store, but pushing failed: ${safe(messageOf(err))}. shadowlap push ${ready.map((id) => shortId(id)).join(' ')} sends ${ready.length === 1 ? 'it' : 'them'}.`));
  }
}

/** `shadowlap test --push`: every test run, and the report, go to the store. */
export interface TestPusher {
  /** Pushes the runs a pack's attempts made (and the golden they replayed). Never throws. */
  pushRuns(store: Store, runIds: string[]): Promise<void>;
  /** Uploads the session's report and prints what was pushed. Never throws. */
  finish(report: TestReport): Promise<void>;
}

export async function prepareTestPush(t: TeamEnv, options: { annotations?: boolean } = {}): Promise<TestPusher | null> {
  const warn = (message: string) => {
    // Messages carry what a store or a bucket said: shown, never acted on by a terminal or the CI.
    note(t, p.yellow(`! --push: ${safeText(message)}`));
    if (options.annotations) t.io.out(`::warning title=shadowlap test --push::${safe(message.replace(/\r?\n/g, ' '))}\n`);
  };
  let loc: StoreLocation | null;
  try {
    loc = configuredStore(t);
  } catch (err) {
    warn(messageOf(err));
    return null;
  }
  if (!loc) {
    warn(`no team store is set in ${CONFIG_FILE} (shadowlap store set <url>); the tests run without pushing.`);
    return null;
  }
  // Settings → Store's switch: the team turned pushing from CI off.
  if (ciProvider(t.env) && config(t).ciPush === false) {
    note(t, p.dim(`--push: Push from CI is off ("ciPush": false in ${CONFIG_FILE}); the tests run and their runs stay in this job. shadowlap store push-from-ci on turns it back on.`));
    return null;
  }
  let target: WriteTarget;
  try {
    target = writeTarget(t, loc);
  } catch (err) {
    warn(`${messageOf(err)} The tests run; their runs stay here.`);
    return null;
  }
  const remote = openRemote(t, target.loc);
  try {
    await remote.credentials();
  } catch (err) {
    warn(`no credentials for ${target.loc.url}: ${messageOf(err)} The tests run; their runs stay here.`);
    return null;
  }
  if (target.pr) note(t, p.dim(`--push: ${pullRequestLine(target)}`));
  const who = actor(t);
  const tally = { pushed: 0, failed: 0 };
  return {
    async pushRuns(store, runIds) {
      try {
        const result = await push({ store, remote, actor: who, ci: ciProvider(t.env), pullRequest: target.pr, now: t.now }, { runIds });
        tally.pushed += result.pushed.length + result.updated.length;
      } catch (err) {
        tally.failed++;
        warn(`couldn't push ${runIds.map((id) => shortId(id)).join(', ')}: ${messageOf(err)}`);
      }
    },
    async finish(report) {
      try {
        const id = ulid(t.now());
        const doc = { format: 'shadowlap-store-tests', version: 1, at: t.now(), by: who, ...(target.pr ? { pullRequest: target.pr } : {}), report };
        await remote.put(storeKeys.tests(id), Buffer.from(JSON.stringify(doc), 'utf8'), { contentType: 'application/json', ifNoneMatch: true }).catch((err: unknown) => {
          // The key is this session's own: it exists only if a retried write already landed.
          if (!isPrecondition(err)) throw err;
        });
        note(t, p.dim(`pushed ${plural(tally.pushed, 'run')} and the report to ${target.loc.url}${tally.failed ? ` (${tally.failed} push${tally.failed === 1 ? '' : 'es'} failed)` : ''}`));
      } catch (err) {
        warn(`couldn't upload the report: ${messageOf(err)}`);
      }
    },
  };
}
