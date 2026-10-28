import { aboutOf, classifyRun, kindFacts, runAsk, runKind, type AttemptKind, type RunAbout, type RunRecord, type Store } from '@shadowlap/engine';
import { cells, truncate } from './render.js';

/**
 * A run's about line, the quiet line every dashboard page names a run by beside its id: what it was
 * (for a recording, the first thing its user asked; for a fork, the change that made it; for an
 * attempt, which), from the engine's `aboutOf` with the facts the dashboard gives it
 * (packages/dashboard/src/run-about.ts). The ask is read from the run's first model requests only:
 * the dashboard reads every request of a finished run of several agents to find the one under test,
 * which a terminal can't wait for on a long run.
 */

/** About lines by what they depend on: a run still recording is worked out again only when it has more calls. */
const cache = new WeakMap<Store, Map<string, RunAbout>>();
const CACHED = 5000;
/** The first calls of a recording `runAsk` reads its ask from: the first few model requests are among them. */
const ASK_CALLS = 200;

/**
 * A bundled attempt's place among its run's attempts of the same kind (from 1), as the dashboard
 * numbers it: a probe counts the fork blame rescued its run with among its probes.
 */
function attemptIndex(store: Store, run: RunRecord, kind: AttemptKind, parent: RunRecord | null): number {
  if (!run.parentRunId) return 1;
  const group = run.meta?.repeat?.group ?? null;
  const rescuedId = kind === 'probe' ? parent?.meta?.blame?.rescuedRunId : null;
  const same = store.childRuns(run.parentRunId).filter((a) => {
    if (group !== null && a.meta?.repeat?.group !== group) return false;
    if (a.runId !== rescuedId && classifyRun(a).attemptKind !== kind) return false;
    if (kind === 'probe') return a.meta?.probe?.callNo === run.meta?.probe?.callNo || a.runId === rescuedId;
    if (kind === 'verify') return a.meta?.verify?.role === run.meta?.verify?.role;
    return true;
  });
  const order = (a: RunRecord) => (group !== null ? (a.meta?.repeat?.attempt ?? 0) : 0);
  same.sort((a, b) => order(a) - order(b) || a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : 1));
  return Math.max(1, same.findIndex((a) => a.runId === run.runId) + 1);
}

/** Whether the fork's change overrides a call a person answered (a recorded user input): its about line says `answer #n`. */
function answered(store: Store, parent: RunRecord | null, about: RunAbout): boolean {
  const n = about.change?.flag === '--override' ? about.change.callNo : null;
  if (!parent || n === null) return false;
  return store.getCalls(parent.runId, { only: [n] })[0]?.meta.input === true;
}

function workOut(store: Store, run: RunRecord, calls: number, parent: RunRecord | null): RunAbout {
  const kind = runKind(run, kindFacts(store, run, calls));
  const c = classifyRun(run);
  const attempt = c.attemptKind && c.attemptOf ? { kind: c.attemptKind, index: attemptIndex(store, run, c.attemptKind, parent) } : null;
  const asks = kind === 'recording' || kind === 'pack';
  const facts = {
    kind,
    argv: run.command.argv,
    codeVersion: run.codeVersion,
    parent: parent ? { codeVersion: parent.codeVersion } : null,
    divergence: run.divergence,
    meta: run.meta ?? null,
    attempt,
    rescued: !!parent && parent.meta?.blame?.rescuedRunId === run.runId,
    ...(asks ? { ask: runAsk(store, store.getCalls(run.runId, { limit: ASK_CALLS })) } : {}),
  };
  const about = aboutOf(facts);
  return answered(store, parent, about) ? aboutOf({ ...facts, answered: true }) : about;
}

export function aboutRun(store: Store, run: RunRecord, calls = store.countCalls(run.runId)): RunAbout {
  let byKey = cache.get(store);
  if (!byKey) cache.set(store, (byKey = new Map<string, RunAbout>()));
  const parent = run.parentRunId ? store.getRun(run.parentRunId) : null;
  const rescued = parent?.meta?.blame?.rescuedRunId === run.runId;
  const key = `${run.runId}|${run.status}|${String(run.endedAt)}|${calls}|${rescued ? 1 : 0}`;
  let about = byKey.get(key);
  if (!about) {
    try {
      about = workOut(store, run, calls, parent);
    } catch {
      about = { text: run.command.argv.join(' '), from: 'command' };
    }
    if (byKey.size > CACHED) byKey.clear();
    byKey.set(key, about);
  }
  return about;
}

/**
 * An about line in `width` columns, as the dashboard fits one: cut at whole words with `…` in the
 * middle (*Ticket T-8812 … arrived damaged*), so both its start and its end still read; a change
 * (`override #16`) is short and never cut there.
 */
export function fitAbout(about: Pick<RunAbout, 'text' | 'from'>, width: number): string {
  const text = about.text.replace(/\s+/g, ' ').trim();
  if (cells(text) <= width || about.from === 'change') return text;
  const words = text.split(' ');
  if (words.length < 3) return truncate(text, width);
  let head = 1;
  let tail = 1;
  const at = (h: number, t: number) => `${words.slice(0, h).join(' ')} … ${words.slice(-t).join(' ')}`;
  if (cells(at(head, tail)) > width) return truncate(text, width);
  // Grow the start and the end in turn, while both still fit and leave a word out between them.
  for (let grow = 0; head + tail < words.length - 1; grow++) {
    const [h, t] = grow % 2 === 0 ? [head + 1, tail] : [head, tail + 1];
    if (cells(at(h, t)) > width) break;
    [head, tail] = [h, t];
  }
  return at(head, tail);
}
