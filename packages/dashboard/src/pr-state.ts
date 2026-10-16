import { execFile, execFileSync } from 'node:child_process';
import type { Store, StoredFix } from '@shadowlap/engine';

/**
 * Where a fix's pull request stands, read from the forge: a fix that `repair --pr` or CI's fix on
 * failure opened a pull request for shows "PR #138 merged" once it is. The state is read with the
 * GitHub CLI (`gh pr view <url> --json state`) when it is installed and signed in, in the
 * background and within a short timeout, so a page never waits for it; when `gh` is missing, or
 * signed out of a host, it isn't asked again (there) for a while. Only GitHub pull requests are
 * read, and only on hosts this project uses (`readableHosts`); the state of any other is left as
 * it was recorded.
 */

export type PrState = 'open' | 'merged' | 'closed';

/** A GitHub pull request's web address, as `gh pr view` takes it: on github.com, or on a GitHub server of your own. */
const GITHUB_PR = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?::\d{1,5})?\/[\w.-]{1,100}\/[\w.-]{1,100}\/pull\/\d{1,12}$/;

/** Whether an address has the shape of a GitHub pull request's. Which hosts are read is `readableHosts`'s to say. */
export function isGithubPr(url: unknown): url is string {
  return typeof url === 'string' && GITHUB_PR.test(url);
}

/** The host name a pull request's address names, lowercased and without its port: `github.com`. */
export function prHost(url: string): string {
  return /^https:\/\/([^/:]+)/.exec(url)?.[1]?.toLowerCase() ?? '';
}

/** A host name as `GH_HOST` may give it: `ghes.example.com`, perhaps with a scheme or a port. */
const hostName = (raw: string | undefined): string | null => {
  const host = raw?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  return host || null;
};

/** The host name of a git remote's address: `https://host/…`, `ssh://user@host:22/…` or `user@host:owner/repo`. */
export function remoteHost(remote: string): string | null {
  const text = remote.trim();
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(text);
  if (url) return url[1]!.toLowerCase();
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)/.exec(text);
  return scp ? scp[1]!.toLowerCase() : null;
}

/** How long the origin remote's host is kept before git is asked again. */
const ORIGIN_FOR_MS = 5 * 60_000;
const origins = new Map<string, { host: string | null; at: number }>();

/** The host of a project's `origin` remote, asked of git and kept a few minutes; null when there is none. */
function originHost(projectDir: string, now = Date.now()): string | null {
  const kept = origins.get(projectDir);
  if (kept && now - kept.at < ORIGIN_FOR_MS) return kept.host;
  let host: string | null = null;
  try {
    host = remoteHost(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: projectDir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString());
  } catch {
    // not a repository, or no origin
  }
  if (origins.size >= 16) origins.delete(origins.keys().next().value!);
  origins.set(projectDir, { host, at: now });
  return host;
}

/**
 * The hosts whose pull requests are read: github.com, the host gh is told to use (`GH_HOST`), and
 * the host of the project's `origin` remote (a GitHub server of your own). A fix's address is store
 * data, which a pull from the team store brings from anyone: one on any other host is never handed
 * to gh, which would send that host a token.
 */
export function readableHosts(projectDir: string | null, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set(['github.com']);
  const ghHost = hostName(env.GH_HOST);
  if (ghHost) hosts.add(ghHost);
  const origin = projectDir ? originHost(projectDir) : null;
  if (origin) hosts.add(origin);
  return hosts;
}

/** The state `gh pr view --json state` printed: `{"state":"MERGED"}`, or null for anything else. */
export function parsePrState(stdout: string): PrState | null {
  try {
    const state = (JSON.parse(stdout) as { state?: unknown }).state;
    return state === 'OPEN' ? 'open' : state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : null;
  } catch {
    return null;
  }
}

/**
 * What reading one pull request's state gave: the state, or none, and whether gh can't be used for
 * that pull request's host (signed out of it), or anywhere (`missing`: not installed).
 */
export type PrRead = { state: PrState } | { state: null; unusable: boolean; missing?: boolean };

/** Reads a pull request's state and calls back once, never throwing. */
export type PrReader = (url: string, done: (read: PrRead) => void) => void;

/** How long `gh` gets to answer. */
export const GH_TIMEOUT_MS = 5000;

/**
 * The tokens gh reads for a GitHub server of your own, and sends to any host but github.com: named
 * GH_…_TOKEN or GITHUB_…_TOKEN (GH_TOKEN and GITHUB_TOKEN, github.com's own, aren't). They are kept
 * only for the host `GH_HOST` names, which they are for.
 */
const SERVER_TOKEN = /^(?:GH|GITHUB)_[A-Z0-9_]+_TOKEN$/;

/** gh's environment for one pull request: no prompt, no colours, and no server token for a host it isn't for. */
export function ghEnv(url: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  const ghHost = hostName(env.GH_HOST);
  if (!ghHost || prHost(url) !== ghHost) for (const name of Object.keys(out)) if (SERVER_TOKEN.test(name)) delete out[name];
  return out;
}

/** github.com's pull requests: what is read when nothing says which hosts may be. */
const onGithubCom = (url: string) => prHost(url) === 'github.com';

/**
 * Reads a pull request's state with the GitHub CLI, in the background: `gh pr view <url> --json
 * state`, with no prompt, given `timeoutMs`. Only an address whose host `readable` allows is read.
 * A `gh` that isn't installed is unusable everywhere until that changes; one signed out of the pull
 * request's host, there.
 */
export function ghReader(options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; readable?: (url: string) => boolean } = {}): PrReader {
  const readable = options.readable ?? onGithubCom;
  return (url, done) => {
    if (!isGithubPr(url) || !readable(url)) return done({ state: null, unusable: false });
    let called = false;
    const once = (read: PrRead) => {
      if (called) return;
      called = true;
      done(read);
    };
    try {
      execFile('gh', ['pr', 'view', url, '--json', 'state'], { timeout: options.timeoutMs ?? GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024, env: ghEnv(url, options.env ?? process.env) }, (err, stdout, stderr) => {
        if (err) {
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
          const signedOut = /gh auth login|not logged in|authentication required|no oauth token/i.test(String(stderr));
          return once({ state: null, unusable: missing || signedOut, ...(missing ? { missing } : {}) });
        }
        const state = parsePrState(String(stdout));
        once(state ? { state } : { state: null, unusable: false });
      });
    } catch {
      once({ state: null, unusable: true, missing: true });
    }
  };
}

/** A fix's pull request still open as recorded, whose state the forge can tell: what `PrStates` asks about. */
export function openPullRequest(fix: StoredFix): string | null {
  const pr = fix.data.source?.pr;
  return pr && (pr.state ?? 'open') === 'open' && isGithubPr(pr.url) ? pr.url : null;
}

export interface PrStatesOptions {
  read: PrReader;
  /** Records a state that changed. */
  write: (fixId: string, state: PrState) => void;
  /** Which addresses may be read (default: github.com's): `readableHosts`. */
  readable?: (url: string) => boolean;
  now?: () => number;
  /** How long an answer stands before the same pull request is asked about again (default 5 minutes). */
  everyMs?: number;
  /** How long nothing is asked of a host after gh turned out signed out of it, or of any once gh is missing (default 30 minutes). */
  pauseMs?: number;
  /** How many are asked about at once (default 2). */
  parallel?: number;
}

/** Where a pause for every host is kept, beside those of one host each. */
const EVERY_HOST = '';

/**
 * Keeps fixes' pull request states current while their pages are read: each read starts asking
 * about the open pull requests not asked about lately, and returns at once; an answer that differs
 * from what the store says is written to it, which brings the pages up to date as any change does.
 * A merged or closed pull request is not asked about again.
 */
export class PrStates {
  private readonly asked = new Map<string, number>();
  private running = 0;
  /** Until when nothing is asked of a host, by its name, or of any (`EVERY_HOST`). */
  private readonly pausedUntil = new Map<string, number>();
  private readonly now: () => number;
  private readonly everyMs: number;
  private readonly pauseMs: number;
  private readonly parallel: number;
  private readonly readable: (url: string) => boolean;

  constructor(private readonly o: PrStatesOptions) {
    this.now = o.now ?? Date.now;
    this.everyMs = o.everyMs ?? 5 * 60_000;
    this.pauseMs = o.pauseMs ?? 30 * 60_000;
    this.parallel = o.parallel ?? 2;
    this.readable = o.readable ?? onGithubCom;
  }

  private paused(host: string, now: number): boolean {
    return now < (this.pausedUntil.get(EVERY_HOST) ?? 0) || now < (this.pausedUntil.get(host) ?? 0);
  }

  /** Starts asking about the open pull requests of these fixes that weren't asked about lately. Never waits, never throws. */
  refresh(fixes: readonly StoredFix[]): void {
    const now = this.now();
    for (const fix of fixes) {
      if (this.running >= this.parallel) return;
      const url = openPullRequest(fix);
      if (!url || !this.readable(url) || now - (this.asked.get(url) ?? -Infinity) < this.everyMs) continue;
      const host = prHost(url);
      if (this.paused(host, now)) continue;
      this.asked.set(url, now);
      this.running++;
      this.o.read(url, (read) => {
        this.running--;
        if (read.state === null) {
          // gh missing pauses every host; signed out of one, that one.
          if (read.unusable) this.pausedUntil.set(read.missing ? EVERY_HOST : host, this.now() + this.pauseMs);
          return;
        }
        if (read.state === 'open') return;
        try {
          this.o.write(fix.fixId, read.state);
        } catch {
          // the fix is gone, or the store is closing: the next read asks again
          this.asked.delete(url);
        }
      });
    }
  }
}

/**
 * A refresher that writes what it reads to `store`, as `{ source: { pr: { state } } }` merged into
 * the fix's data, reading only pull requests on the hosts the project uses (`readableHosts` of
 * `projectDir`).
 */
export function storePrStates(store: () => Store, o: { projectDir?: string | null; read?: PrReader; env?: NodeJS.ProcessEnv } = {}): PrStates {
  const env = o.env ?? process.env;
  const readable = (url: string) => readableHosts(o.projectDir ?? null, env).has(prHost(url));
  return new PrStates({ read: o.read ?? ghReader({ readable, env }), readable, write: (fixId, state) => store().mergeFixData(fixId, { source: { pr: { state } } }) });
}
