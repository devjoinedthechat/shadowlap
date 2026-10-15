import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ciProvider, recordEvent, resolveAuthor, safeText, Store, ulid, type RunRecord } from '@shadowlap/engine';
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
  PROVIDER_NAMES,
  pull,
  pullRequestFolders,
  pullRequestJob,
  pullRequestLocation,
  push,
  queuedRuns,
  recordCheck,
  shareReport,
  SHARE_DAYS,
  LayoutError,
  StoreError,
  StoreUrlError,
  storeKindName,
  teamRunInStore,
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
import { CONFIG_FILE, configPath, defaultDbPath, loadConfig, type ShadowlapConfig } from './config.js';
import { emitJobEvent } from './job-events.js';
import type { TestReport } from './test-report.js';
import { palette as p, safe, shortId } from './ui.js';

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
  constructor(message: string) {
    super(message);
    this.name = 'TeamError';
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
    throw new TeamError(`${CONFIG_FILE}: ${(err as Error).message}`);
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

/** Writes one key into shadowlap.config.json, keeping everything else as the user wrote it. */
function setConfigKey(cwd: string, key: string, value: unknown): void {
  const path = configPath(cwd);
  const existing = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  writeFileSync(path, JSON.stringify({ ...existing, [key]: value }, null, 2) + '\n');
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
  return `${target.source}: its runs go to pull request ${target.pr}'s own folder in the store, which a pull brings only with --include-pr`;
}

// ---------------------------------------------------------------------------------------------- store setup

export function storeSet(t: TeamEnv, url: string, flags: { provider?: Provider; json?: boolean } = {}): number {
  let loc: StoreLocation;
  try {
    loc = parseStoreUrl(url, flags.provider);
  } catch (err) {
    throw new TeamError((err as Error).message);
  }
  const value = formatStoreUrl(loc);
  const previous = config(t).store ?? null;
  setConfigKey(t.cwd, 'store', value);
  withStore(t, (store) => recordEvent(store, { kind: 'store.set', actor: actor(t), ref: loc.url, data: { provider: loc.provider, previous } }));
  const result = { store: value, url: loc.url, provider: loc.provider, bucket: loc.bucket, prefix: loc.prefix, account: loc.account ?? null, region: loc.region ?? null, previous, config: configPath(t.cwd) };
  emitJobEvent({ type: 'result', data: result }, t.env);
  if (flags.json) {
    line(t, JSON.stringify(result, null, 2));
    return 0;
  }
  line(t, `${p.green('✓')} Store set: ${value} ${p.dim(`(${storeKindName(loc)}${loc.region ? `, ${loc.region}` : ''})`)}`);
  line(t, p.dim(`  wrote "store" to ${CONFIG_FILE}${previous && previous !== value ? `, replacing ${previous}` : ''}. Credentials never go there: each machine uses its own.`));
  line(t, p.dim(`  Next: shadowlap store check, then commit ${CONFIG_FILE} so the team uses the same store:`));
  line(t, p.dim(`    git add ${CONFIG_FILE} && git commit -m "Use the team store"`));
  return 0;
}

/**
 * Settings → Store's "Push from CI": writes `ciPush` to shadowlap.config.json. Off, `test --push`
 * in CI runs the tests and keeps their runs in the job; on (the default), it pushes them.
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
  line(t, `${p.green('✓')} Push from CI ${on ? 'on' : 'off'}: shadowlap test --push in CI ${on ? 'pushes every test run and its report' : 'runs the tests and keeps their runs in the job'}.`);
  line(t, p.dim(`  wrote "ciPush": ${on} to ${CONFIG_FILE}; commit it for CI to see it.`));
  return 0;
}

const STEP_WORDS: Record<string, string> = { list: 'list', write: 'write', read: 'read', delete: 'delete' };

export async function storeCheck(t: TeamEnv, flags: { json?: boolean } = {}): Promise<number> {
  const loc = requireStore(t);
  const target = writeTarget(t, loc);
  const remote = openRemote(t, target.loc);
  if (!flags.json) {
    line(t, `Checking ${target.loc.url} ${p.dim(`(${storeKindName(loc)})`)}`);
    if (target.pr) note(t, p.dim(`  ${pullRequestLine(target)}`));
  }
  const check: StoreCheck = await checkStore(remote, { now: t.now });
  const last: LastCheck = { ok: check.ok, at: t.now(), encryption: check.encryption, versioning: check.versioning, objectLock: check.objectLock.state, credentials: check.credentials };
  withStore(t, (store) => {
    recordCheck(store, target.loc.url, last);
    recordEvent(store, { kind: 'store.checked', actor: actor(t), ref: target.loc.url, data: { ok: check.ok, versioning: check.versioning, objectLock: check.objectLock.state, encryption: check.encryption } });
  });
  const result = { ...check, pullRequest: target.pr };
  emitJobEvent({ type: 'result', data: result }, t.env);
  if (flags.json) {
    line(t, JSON.stringify(result, null, 2));
    return check.ok ? 0 : 1;
  }
  line(t, p.dim(`  credentials: ${check.credentials ?? 'none found'}`));
  for (const s of check.steps) line(t, `  ${s.ok ? p.green('✓') : p.red('✗')} ${STEP_WORDS[s.name]}${s.detail ? p.dim(`  ${safe(s.detail)}`) : ''}`);
  line(t, `  Encryption   ${check.encryption ?? p.yellow('not reported')}`);
  line(t, `  Versioning   ${check.versioning}`);
  line(t, `  Object lock  ${check.objectLock.state}${check.objectLock.detail ? p.dim(` (${safe(check.objectLock.detail)})`) : ''}`);
  for (const w of check.warnings) note(t, p.yellow(`! ${w}`));
  for (const n of check.notes) note(t, p.dim(`  ${n}`));
  if (!check.ok) {
    note(t, p.red(`✗ ${checkFailure(target.loc, check.failure)}`));
    return 1;
  }
  line(t, `${p.green('✓')} The store works: list, write, read and delete.`);
  line(t, p.dim('  Next: shadowlap push --all'));
  return 0;
}

/** What a failed store check means, and what to do next, by the kind of its first failure. */
function checkFailure(loc: StoreLocation, failure: StoreCheck['failure']): string {
  switch (failure) {
    case 'network':
      return `Couldn't reach ${loc.url}: check the address${loc.endpoint ? ` (${loc.endpoint})` : ''} and this machine's network, then run shadowlap store check again.`;
    case 'credentials':
      return `The credentials on this machine don't work for ${loc.url} (see the first step above). Sign in, or set the right keys, the way the cloud's own tools find them; then run shadowlap store check again.`;
    case 'no-bucket':
      return `${loc.url} names a bucket these credentials can't find. Check the name, then set it again with shadowlap store set <url>.`;
    case 'denied':
      return `These credentials can't use ${loc.url} yet. The access to ask your cloud admin for: shadowlap store policy`;
    default:
      return `${loc.url} didn't work with these credentials: see the steps above. If it is access, ask your cloud admin for what shadowlap store policy prints.`;
  }
}

export function storePolicy(t: TeamEnv, flags: { provider?: Provider; json?: boolean } = {}): number {
  let loc: StoreLocation | null = null;
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
  note(t, p.dim(`# The access to ask your cloud admin for (${PROVIDER_NAMES[provider]}): one policy for people and protected branches, one for pull requests`));
  for (const [i, part] of [policy.writer, policy.pullRequest].entries()) {
    note(t, p.dim(`#\n# ${i + 1}. For ${part.for}: ${part.kind}`));
    line(t, part.text);
    for (const n of part.notes) note(t, p.dim(`# ${n}`));
  }
  if (policy.notes.length) note(t, p.dim('#'));
  for (const n of policy.notes) note(t, p.dim(`# ${n}`));
  return 0;
}

export function storeCi(t: TeamEnv, flags: { provider: CiProvider; packs?: string; json?: boolean }): number {
  const loc = requireStore(t);
  const step = ciStep(flags.provider, loc, flags.packs ?? 'goldens/*');
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
  /** Runs in the store, as far as this machine knows (its pushes and the index it last read). */
  inStore: number;
  /** Runs here that aren't in the store. */
  onlyLocal: number;
  /** Runs queued while recording, pushed when they end. */
  queued: number;
  /** The last `shadowlap store check` here. */
  check: LastCheck | null;
}

export function storeStatus(store: Store, loc: StoreLocation, value: string): StoreStatus {
  const sync = store.teamSync(loc.url);
  const summary = store.teamSummary(loc.url);
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
    inStore: summary.inStore,
    onlyLocal: store.teamLocalOnly(loc.url, 0).count,
    queued: summary.queued,
    check: lastCheck(store, loc.url),
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

function runList(store: Store, args: string[]): string[] {
  return args.map((arg) => {
    const run = store.findRun(arg);
    if (!run) throw new TeamError(`no run matches "${arg}" (see: shadowlap ls)`);
    return run.runId;
  });
}

function onlyLocal(store: Store, url: string): number {
  return store.teamLocalOnly(url, 0).count;
}

/** A store or bucket-layout failure, in words, as a TeamError: the command prints it without a stack. */
function asTeamError(err: unknown, hint?: string): unknown {
  if (err instanceof StoreError || err instanceof LayoutError || err instanceof StoreUrlError) return new TeamError(hint ? `${err.message}\n${hint}` : err.message);
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
  try {
    const runIds = runList(store, runArgs);
    const who = actor(t);
    if (!flags.json) {
      note(t, p.dim(`Pushing to ${target.loc.url} as ${safe(who ?? 'an unknown author')} with ${safe(await remote.credentials().catch(() => 'no credentials'))}`));
      if (target.pr) note(t, p.dim(`  ${pullRequestLine(target)}`));
    }
    try {
      result = await push({ store, remote, actor: who, ci: ciProvider(t.env), pullRequest: target.pr, now: t.now, ...(flags.json ? {} : { log: (l: string) => note(t, p.dim(`  ${safe(l)}`)) }) }, { runIds, ...(flags.all ? { all: true } : {}) });
    } catch (err) {
      throw asTeamError(err, 'The runs that went up before it are in the store, listed for the team; push again to send the rest.');
    }
    left = onlyLocal(store, target.loc.url);
    recordEvent(store, {
      kind: 'store.pushed',
      actor: who,
      ref: target.loc.url,
      data: { pushed: result.pushed.length, updated: result.updated.length, repaired: result.repaired.length, queued: result.queued.length, refused: result.refused.length, blobs: result.blobs.uploaded, bytes: result.blobs.bytes, ...(target.pr ? { pullRequest: target.pr } : {}) },
    });
  } finally {
    store.close();
  }
  const out = { store: target.loc.url, pullRequest: target.pr, ...result, onlyLocal: left };
  emitJobEvent({ type: 'result', data: out }, t.env);
  if (result.pushed.length || result.updated.length || result.repaired.length) emitJobEvent({ type: 'link', label: 'Open Runs', href: '#/runs' }, t.env);
  // Runs that were named and can't go: the command didn't do what it was asked.
  const code = runArgs.length && result.refused.length ? 1 : 0;
  if (flags.json) {
    line(t, JSON.stringify(out, null, 2));
    return code;
  }
  const parts = [plural(result.pushed.length, 'run') + ' pushed'];
  if (result.updated.length) parts.push(`${result.updated.length} updated ${p.dim('(labels, notes, results)')}`);
  if (result.unchanged.length) parts.push(`${result.unchanged.length} already there`);
  if (result.repaired.length) parts.push(`${result.repaired.length} mended ${p.dim('(parts the store had lost, sent again)')}`);
  line(t, `${p.green('✓')} ${parts.join(', ')} · ${plural(result.blobs.uploaded, 'blob')} uploaded (${bytes(result.blobs.bytes)})${result.blobs.present ? `, ${result.blobs.present} already in the store` : ''}`);
  if (result.queued.length) line(t, p.dim(`  ${plural(result.queued.length, 'run')} still recording: ${result.queued.length === 1 ? 'it goes' : 'they go'} when ${result.queued.length === 1 ? 'it ends' : 'they end'} (${result.queued.map((id) => shortId(id)).join(', ')})`));
  if (result.refused.length) problemLines(t, `${plural(result.refused.length, 'run')} stayed on this machine:`, result.refused);
  return code;
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
  let left: number;
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
        const own = new Set(store.teamRuns(loc.url).filter(teamRunInStore).map((r) => r.runId));
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
    left = onlyLocal(store, loc.url);
    recordEvent(store, {
      kind: 'store.pulled',
      actor: actor(t),
      ref: loc.url,
      data: { pulled: result.pulled.length, merged: result.merged.length, failed: result.failed.length, byAuthor: result.byAuthor, ...(flags.includePr ? { pullRequests: prs.map((x) => ({ number: x.number, pulled: x.pulled.length })) } : {}) },
    });
  } finally {
    store.close();
  }
  for (const runId of [...result.pulled, ...prs.flatMap((x) => x.pulled)]) emitJobEvent({ type: 'run', runId, role: 'imported' }, t.env);
  const out = { store: loc.url, ...result, onlyLocal: left, pullRequests: prs };
  emitJobEvent({ type: 'result', data: out }, t.env);
  // Names that match nothing, or named runs that couldn't come: the command didn't do what it was asked.
  const failed = result.failed.length + prs.reduce((n, x) => n + x.failed.length, 0);
  const code = result.unknown.length || (runArgs.length && failed) ? 1 : 0;
  if (flags.json) {
    line(t, JSON.stringify(out, null, 2));
    return code;
  }
  const by = Object.entries(result.byAuthor)
    .sort((a, b) => b[1] - a[1])
    .map(([who, n]) => `${safe(who.includes('@') ? who.split('@')[0]! : who)} ${n}`);
  line(t, `${p.green('✓')} ${plural(result.pulled.length, 'run')} pulled${by.length ? ` ${p.dim(`(${by.join(', ')})`)}` : ''}${result.blobs.downloaded ? ` · ${plural(result.blobs.downloaded, 'blob')} (${bytes(result.blobs.bytes)})` : ''}${result.merged.length ? ` · ${plural(result.merged.length, "run's labels and notes", "runs' labels and notes")} merged` : ''}`);
  line(t, p.dim(`  The store has ${plural(result.inStore, 'run')}; ${left} only on this machine${left ? ' (shadowlap push --all sends them)' : ''}.`));
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
  for (const name of result.unknown) note(t, p.red(`✗ No run in the store matches "${safe(name)}" (or more than one does).`));
  return code;
}

export async function teamShare(t: TeamEnv, runArg: string, flags: { lineage?: boolean; json?: boolean; version?: string; uiDir?: string } = {}): Promise<number> {
  const loc = requireStore(t);
  // The run first: a name that matches nothing says so before anything is asked of the store.
  const found = withStore(t, (store) => store.findRun(runArg));
  if (!found) throw new TeamError(`no run matches "${safe(runArg)}" (see: shadowlap ls)`);
  const run: RunRecord = found;
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
    ready = withStore(t, (store) => queuedRuns(store, url).ready);
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
      recordEvent(store, { kind: 'store.pushed', actor: actor(t), ref: url, data: { pushed: result.pushed.length, updated: result.updated.length, refused: result.refused.length, queued: true } });
    } finally {
      store.close();
    }
  } catch (err) {
    note(t, p.yellow(`! ${which} queued for the store, but pushing failed: ${safe((err as Error).message)}. shadowlap push ${ready.map((id) => shortId(id)).join(' ')} sends ${ready.length === 1 ? 'it' : 'them'}.`));
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
    warn((err as Error).message);
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
    warn(`${(err as Error).message} The tests run; their runs stay here.`);
    return null;
  }
  const remote = openRemote(t, target.loc);
  try {
    await remote.credentials();
  } catch (err) {
    warn(`no credentials for ${target.loc.url}: ${(err as Error).message} The tests run; their runs stay here.`);
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
        warn(`couldn't push ${runIds.map((id) => shortId(id)).join(', ')}: ${(err as Error).message}`);
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
        warn(`couldn't upload the report: ${(err as Error).message}`);
      }
    },
  };
}
