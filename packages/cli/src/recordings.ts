import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { divergenceLine, finalAnswer, formatDivergence, formatSummary, packRun, unpackRun, type CallKind, type Normalizer, type Origin, type Store } from '@shadowlap/engine';
import { HttpError, type ApiRoute, type Sidecar } from '@shadowlap/sidecar';
import { stampAuthor } from './activity.js';

/**
 * Recordings for test suites, behind `shadowlap serve --recordings`. A test-runner plugin (pytest,
 * Vitest) asks for a recording when a test starts: the test replays its committed recording offline
 * when there is one, and records a new one when there isn't. When the test ends, a new recording is
 * packed next to the test, and a replay that diverged is reported, and kept in the local store to
 * inspect.
 *
 *   POST /v1/recordings/start  { recording, slot, mode?, name?, command? } → { runId, mode, recording }
 *   POST /v1/recordings/calls  { runId }                                   → RecordedCalls, so far
 *   POST /v1/recordings/end    { runId, passed }                           → RecordingResult
 */

/** `missing`: replay when a recording exists, record otherwise. `all`: always record. `none`: only replay. */
export type RecordMode = 'missing' | 'all' | 'none';

export interface RecordingResult {
  ok: boolean;
  mode: 'record' | 'replay';
  runId: string;
  /** The recording directory, relative to the project. */
  recording: string;
  /** Record: whether the pack was written. */
  saved?: boolean;
  calls: number;
  replayed: number;
  /** One line, for a failure or a note worth showing (nothing recorded, test failed so nothing saved). */
  message: string | null;
  /** The divergence report and run summary, for a failure. */
  report: string | null;
}

/** What a test can assert on while its recording runs: the calls the agent made, and its last answer. */
export interface RecordedCalls {
  calls: RecordedCall[];
  /** The text of the last model response; null before one. */
  answer: string | null;
}

export interface RecordedCall {
  callNo: number;
  kind: CallKind;
  name: string;
  /** `live`, `replayed`, or, for a write after a fork, `blocked` or `stubbed`. */
  origin: Origin;
  /** null while the call is in flight. */
  outcome: 'ok' | 'error' | null;
  scope?: string;
  /** Model calls. */
  model?: string;
  /** Tool calls: the arguments, and the result or error as the agent got it. */
  args?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ActiveRecording {
  runId: string;
  mode: 'record' | 'replay';
  dir: string;
  slot: string;
}

export class RecordingHost {
  private sidecar: Sidecar | null = null;
  private readonly active = new Map<string, ActiveRecording>();

  constructor(
    private readonly store: Store,
    private readonly root: string,
    private readonly opts: { codeVersion: string | null; redact: Normalizer[] },
  ) {}

  attach(sidecar: Sidecar): void {
    this.sidecar = sidecar;
  }

  readonly api = async (route: ApiRoute): Promise<{ status: number; body: unknown } | undefined> => {
    if (route.method !== 'POST') return undefined;
    if (route.path === 'v1/recordings/start') return { status: 201, body: this.start((await route.body()) as StartBody) };
    if (route.path === 'v1/recordings/calls') return { status: 200, body: this.calls((await route.body()) as EndBody) };
    if (route.path === 'v1/recordings/end') return { status: 200, body: this.end((await route.body()) as EndBody) };
    return undefined;
  };

  private dirFor(recording: unknown): string {
    if (typeof recording !== 'string' || !recording.trim()) throw new HttpError(400, 'recording must be a directory path');
    const dir = resolve(this.root, recording);
    const rel = relative(this.root, dir);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new HttpError(400, `recordings live inside the project (${this.root}): ${recording}`);
    return dir;
  }

  start(body: StartBody): { runId: string; mode: 'record' | 'replay'; recording: string } {
    const sidecar = this.sidecar!;
    const dir = this.dirFor(body.recording);
    const slot = typeof body.slot === 'string' ? body.slot : 'main';
    const mode: RecordMode = body.mode === 'all' || body.mode === 'none' ? body.mode : 'missing';
    // A test that never ended (a crashed worker) gives its slot up to the next one.
    for (const [runId, a] of this.active) {
      if (a.slot !== slot) continue;
      this.active.delete(runId);
      sidecar.endRun(runId, 'crashed');
    }
    const exists = existsSync(join(dir, 'run.json'));
    const rel = relative(this.root, dir).split('\\').join('/');
    const command = { argv: Array.isArray(body.command) && body.command.every((a) => typeof a === 'string') ? (body.command as string[]) : ['<test>', String(body.name ?? rel)], cwd: this.root };
    if (mode === 'all' || (!exists && mode === 'missing')) {
      const run = sidecar.startRun({ mode: 'record', command, codeVersion: this.opts.codeVersion, slot });
      stampAuthor(this.store, run.runId);
      this.active.set(run.runId, { runId: run.runId, mode: 'record', dir, slot });
      return { runId: run.runId, mode: 'record', recording: rel };
    }
    if (!exists) throw new HttpError(404, `no recording at ${rel}. Record it by running the test without SHADOWLAP_RECORD=none (the default outside CI).`);
    const { imported, skipped } = unpackRun(this.store, dir);
    const parentRunId = imported.at(-1) ?? skipped.at(-1);
    if (!parentRunId) throw new HttpError(422, `${rel} contains no runs`);
    const covers = this.store.getRun(parentRunId)?.meta?.covers;
    const run = sidecar.startRun({ mode: 'replay', parentRunId, command, codeVersion: this.opts.codeVersion, slot, offline: true, replay: { writes: 'block', reads: 'live', liveTools: new Set(), ...(covers?.length ? { kinds: new Set(covers) } : {}) } });
    stampAuthor(this.store, run.runId);
    this.active.set(run.runId, { runId: run.runId, mode: 'replay', dir, slot });
    return { runId: run.runId, mode: 'replay', recording: rel };
  }

  calls(body: { runId?: unknown }): RecordedCalls {
    const a = typeof body.runId === 'string' ? this.active.get(body.runId) : undefined;
    if (!a) throw new HttpError(404, `no recording in progress for run ${String(body.runId)}`);
    const calls = this.store.getCalls(a.runId);
    return {
      calls: calls.map((c) => {
        const call: RecordedCall = { callNo: c.callNo, kind: c.kind, name: c.name, origin: c.origin, outcome: c.end?.outcome ?? null };
        if (typeof c.meta.scope === 'string') call.scope = c.meta.scope;
        const model = c.end?.meta.model ?? c.meta.model;
        if (c.kind === 'api' && typeof model === 'string') call.model = model;
        if (c.kind === 'tool') {
          if (c.requestRef) call.args = this.store.getJson<{ args?: unknown }>(c.requestRef)?.args ?? null;
          const payload = c.end?.responseRef ? this.store.getJson<{ result?: unknown; error?: unknown }>(c.end.responseRef) : null;
          if (payload && 'result' in payload) call.result = payload.result;
          if (payload && 'error' in payload) call.error = payload.error;
        }
        return call;
      }),
      answer: finalAnswer(this.store, calls),
    };
  }

  end(body: EndBody): RecordingResult {
    const sidecar = this.sidecar!;
    const a = typeof body.runId === 'string' ? this.active.get(body.runId) : undefined;
    if (!a) throw new HttpError(404, `no recording in progress for run ${String(body.runId)}`);
    this.active.delete(a.runId);
    const passed = body.passed === true;
    const { summary } = sidecar.endRun(a.runId, passed ? 'completed' : 'failed');
    const recording = relative(this.root, a.dir).split('\\').join('/');
    const base = { runId: a.runId, recording, calls: summary.total, replayed: summary.byOrigin.replayed + summary.byOrigin.overridden };

    if (a.mode === 'record') {
      if (!passed) return { ...base, ok: true, mode: 'record', saved: false, message: 'the test failed, so its recording was not saved', report: null };
      if (summary.total === 0) return { ...base, ok: true, mode: 'record', saved: false, message: 'nothing was recorded: no model or tool call reached Shadowlap during the test', report: null };
      // Written beside the old recording and swapped in, so an interrupted write never leaves half a pack.
      mkdirSync(dirname(a.dir), { recursive: true });
      const tmp = mkdtempSync(join(dirname(a.dir), `.${basename(a.dir)}.tmp-`));
      try {
        packRun(this.store, a.runId, tmp, { redact: this.opts.redact });
        rmSync(a.dir, { recursive: true, force: true });
        renameSync(tmp, a.dir);
      } catch (err) {
        rmSync(tmp, { recursive: true, force: true });
        throw err;
      }
      return { ...base, ok: true, mode: 'record', saved: true, message: null, report: null };
    }

    const d = summary.divergence;
    if (!d) {
      // A clean replay adds nothing worth keeping.
      this.store.deleteRun(a.runId);
      return { ...base, ok: true, mode: 'replay', message: null, report: null };
    }
    // A replay that stopped before its recording did fails as one that diverged: what the agent never
    // sent (the last model turn, a write) is as much a change. Its summary line says it all.
    const early = d.type === 'ended_early';
    return {
      ...base,
      ok: false,
      mode: 'replay',
      message: early ? divergenceLine(d) : `diverged from its recording at call ${d.callNo} (${d.kind} ${d.name})`,
      report: `${early ? '' : `${formatDivergence(d)}\n`}${formatSummary(summary)}\n\nIf the change is intended, record the test again with SHADOWLAP_RECORD=all. To inspect the replay: shadowlap dashboard ${a.runId}`,
    };
  }

  /** Ends whatever is still running (the test runner went away) and drops blobs nothing references. */
  close(): void {
    for (const a of this.active.values()) this.sidecar?.endRun(a.runId, 'crashed');
    this.active.clear();
    this.store.gcBlobs();
  }
}

interface StartBody {
  recording?: unknown;
  slot?: unknown;
  mode?: unknown;
  name?: unknown;
  command?: unknown;
}

interface EndBody {
  runId?: unknown;
  passed?: unknown;
}
