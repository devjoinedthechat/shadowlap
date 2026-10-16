import { execFile } from 'node:child_process';
import type { Store, StoredFix } from '@shadowlap/engine';

/**
 * Where a fix's pull request stands, read from the forge: a fix that `repair --pr` or CI's fix on
 * failure opened a pull request for shows "PR #138 merged" once it is. The state is read with the
 * GitHub CLI (`gh pr view <url> --json state`) when it is installed and signed in, in the
 * background and within a short timeout, so a page never waits for it; when `gh` is missing or
 * signed out, it isn't asked again for a while. Only GitHub pull requests are read; the state of
 * any other is left as it was recorded.
 */

export type PrState = 'open' | 'merged' | 'closed';

/** A GitHub pull request's web address, as `gh pr view` takes it: on github.com, or on a GitHub server of your own. */
const GITHUB_PR = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?::\d{1,5})?\/[\w.-]{1,100}\/[\w.-]{1,100}\/pull\/\d{1,12}$/;

export function isGithubPr(url: unknown): url is string {
  return typeof url === 'string' && GITHUB_PR.test(url);
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

/** What reading one pull request's state gave: the state, or none, and whether the reader can't be used at all (not installed, signed out). */
export type PrRead = { state: PrState } | { state: null; unusable: boolean };

/** Reads a pull request's state and calls back once, never throwing. */
export type PrReader = (url: string, done: (read: PrRead) => void) => void;

/** How long `gh` gets to answer. */
export const GH_TIMEOUT_MS = 5000;

/**
 * Reads a pull request's state with the GitHub CLI, in the background: `gh pr view <url> --json
 * state`, with no prompt, given `timeoutMs`. A `gh` that isn't installed, or isn't signed in to the
 * pull request's host, is unusable until that changes.
 */
export function ghReader(options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): PrReader {
  return (url, done) => {
    if (!isGithubPr(url)) return done({ state: null, unusable: false });
    let called = false;
    const once = (read: PrRead) => {
      if (called) return;
      called = true;
      done(read);
    };
    try {
      execFile(
        'gh',
        ['pr', 'view', url, '--json', 'state'],
        { timeout: options.timeoutMs ?? GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024, env: { ...(options.env ?? process.env), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
        (err, stdout, stderr) => {
          if (err) {
            const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
            const signedOut = /gh auth login|not logged in|authentication required|no oauth token/i.test(String(stderr));
            return once({ state: null, unusable: missing || signedOut });
          }
          const state = parsePrState(String(stdout));
          once(state ? { state } : { state: null, unusable: false });
        },
      );
    } catch {
      once({ state: null, unusable: true });
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
  now?: () => number;
  /** How long an answer stands before the same pull request is asked about again (default 5 minutes). */
  everyMs?: number;
  /** How long nothing is asked after the reader turned out unusable (default 30 minutes). */
  pauseMs?: number;
  /** How many are asked about at once (default 2). */
  parallel?: number;
}

/**
 * Keeps fixes' pull request states current while their pages are read: each read starts asking
 * about the open pull requests not asked about lately, and returns at once; an answer that differs
 * from what the store says is written to it, which brings the pages up to date as any change does.
 * A merged or closed pull request is not asked about again.
 */
export class PrStates {
  private readonly asked = new Map<string, number>();
  private running = 0;
  private pausedUntil = 0;
  private readonly now: () => number;
  private readonly everyMs: number;
  private readonly pauseMs: number;
  private readonly parallel: number;

  constructor(private readonly o: PrStatesOptions) {
    this.now = o.now ?? Date.now;
    this.everyMs = o.everyMs ?? 5 * 60_000;
    this.pauseMs = o.pauseMs ?? 30 * 60_000;
    this.parallel = o.parallel ?? 2;
  }

  /** Starts asking about the open pull requests of these fixes that weren't asked about lately. Never waits, never throws. */
  refresh(fixes: readonly StoredFix[]): void {
    const now = this.now();
    if (now < this.pausedUntil) return;
    for (const fix of fixes) {
      if (this.running >= this.parallel) return;
      const url = openPullRequest(fix);
      if (!url || now - (this.asked.get(url) ?? -Infinity) < this.everyMs) continue;
      this.asked.set(url, now);
      this.running++;
      this.o.read(url, (read) => {
        this.running--;
        if (read.state === null) {
          if (read.unusable) this.pausedUntil = this.now() + this.pauseMs;
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

/** A refresher that writes what it reads to `store`, as `{ source: { pr: { state } } }` merged into the fix's data. */
export function storePrStates(store: () => Store, read: PrReader = ghReader()): PrStates {
  return new PrStates({ read, write: (fixId, state) => store().mergeFixData(fixId, { source: { pr: { state } } }) });
}
