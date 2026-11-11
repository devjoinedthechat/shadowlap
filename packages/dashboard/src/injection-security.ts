import { join } from 'node:path';
import { type Estimate, hasRecordedCommand, injectionEstimate, packRecording, type Price, type RunRecord, type Store, type StoredInjectionResult, type ToolTrust, untrustedView, type UntrustedView } from '@shadowlap/engine';
import { injectionLine, resultGate, toolTrust, type ToolTrustRow } from './injection.js';
import { defaultPayloads } from './injection-plan.js';
import { goldenName } from './needs-look/row.js';
import { estimateOf, pricingOf } from './pricing.js';
import { answer, type ReadTable } from './read-registry.js';
import type { GoldenSource } from './tests.js';
import { toolReads, type ToolReads } from './tool-reads.js';

/**
 * Where an injection test plants, project-wide: Tests' Security (each golden's recording, its
 * untrusted reads and its last test or gate) and, on Settings → Tools, the run each untrusted read's
 * Run injection test… tests. Both read every call of the recordings they name, so they are worked
 * out beside the server (read-jobs.ts), the store's runs bounded to the newest RECENT.
 */

/** A golden's last injection test, as Security's row says it. */
export interface SecurityLast {
  resultId: string;
  verdict: 'passed' | 'failed' | 'inconclusive';
  /** injectionLine's, as Needs a look and a run's banner word it. */
  line: string;
  /** It was the golden's gate, run by a test session, not a test of its recording. */
  gate: boolean;
}

/** One golden whose recording reads something untrusted. */
export interface SecurityRow {
  path: string;
  name: string;
  /** Its recording, where the store holds it: a test runs on it. Null when only its pack holds it, and a test runs on the golden. */
  runId: string | null;
  /** The recording's id, from its pack too, for `its recording <id>`. */
  recording: string;
  /** When it was recorded: the newest golden's recording comes first. */
  at: number;
  reads: UntrustedView[];
  last: SecurityLast | null;
  /** Run injection test… at the plan nobody picked. */
  estimate: Estimate | null;
}

export interface SecurityRead {
  goldens: SecurityRow[];
  /** Goldens whose recordings read nothing untrusted, by name. */
  none: string[];
  /** Goldens whose recording can't be read, with why: listed, never dropped. */
  unread: Array<{ name: string; why: string }>;
}

/** What the pooled job is handed: the config's trust marks, the project's goldens and its folder (a golden's path is under it), and the prices. */
export interface InjectionReadInput {
  tools?: ToolTrust;
  goldens: readonly GoldenSource[];
  project: string;
  prices?: Record<string, Price>;
}

/** The store's runs a tool's test may run on, newest first: at most this many, read when no golden's recording reads the tool. */
export const RECENT = 200;

export const CANT_READ_RECORDING = 'can’t read its recording';

/** A golden's last test: its newest gate, else its recording's newest test that planted. */
function lastTest(store: Store, path: string, recording: string): SecurityLast | null {
  const ended = (rows: StoredInjectionResult[]) => rows.find((r) => r.mode === 'plant' && r.endedAt !== null && resultGate(r) !== null);
  const r = ended(store.listInjectionResults({ golden: path, limit: 50 })) ?? ended(store.listInjectionResults({ runId: recording, limit: 50 }));
  if (!r) return null;
  return { resultId: r.resultId, verdict: resultGate(r)!, line: injectionLine(r), gate: r.golden !== null };
}

/** A recording's untrusted reads and its default plan's price, read from the store that holds it. */
async function readsOf(store: Store, run: RunRecord, o: InjectionReadInput): Promise<{ reads: UntrustedView[]; estimate: Estimate | null }> {
  const reads = untrustedView(store.getCalls(run.runId), o.tools);
  const pricing = pricingOf(store, o.prices);
  const estimate = reads.length ? await estimateOf((p) => injectionEstimate(p.calls(run.runId), reads, { payloads: defaultPayloads(reads.length) }), pricing) : null;
  return { reads, estimate };
}

/** One golden's row: its recording from the store, else from its pack (read into a store of its own, then closed). */
async function goldenRow(store: Store, g: GoldenSource, o: InjectionReadInput): Promise<SecurityRow | { name: string; why: string | null }> {
  const name = goldenName(g.path);
  const held = g.runId ? store.getRun(g.runId) : null;
  let read: { run: RunRecord; reads: UntrustedView[]; estimate: Estimate | null };
  if (held) read = { run: held, ...(await readsOf(store, held, o)) };
  else {
    let pack: ReturnType<typeof packRecording>;
    try {
      pack = packRecording(join(o.project, g.path));
    } catch {
      return { name, why: CANT_READ_RECORDING };
    }
    try {
      read = { run: pack.run, ...(await readsOf(pack.store, pack.run, o)) };
    } finally {
      pack.store.close();
    }
  }
  if (!read.reads.length) return { name, why: null };
  return { path: g.path, name, runId: held ? held.runId : null, recording: read.run.runId, at: read.run.startedAt, reads: read.reads, last: lastTest(store, g.path, read.run.runId), estimate: read.estimate };
}

/** Tests' Security: each golden whose recording reads something untrusted, newest recording first; the others named apart. */
export async function injectionSecurity(store: Store, o: InjectionReadInput): Promise<SecurityRead> {
  const out: SecurityRead = { goldens: [], none: [], unread: [] };
  for (const g of o.goldens) {
    const row = await goldenRow(store, g, o);
    if ('path' in row) out.goldens.push(row);
    else if (row.why) out.unread.push({ name: row.name, why: row.why });
    else out.none.push(row.name);
  }
  out.goldens.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  return out;
}

/** The run Settings → Tools tests an untrusted read in, and what its button's card says. */
export interface ToolTest {
  /** The run tested; null where only a golden's pack holds it, and the test runs on the golden. */
  runId: string | null;
  golden: string | null;
  /** `<golden>’s recording`, or the run's short id. */
  whose: string;
  /** Every untrusted read of that run, where the test plants. */
  reads: UntrustedView[];
  estimate: Estimate | null;
}

/** The store's newest ended recordings that call any of `names` and have a command to run again, newest first, among the newest RECENT. */
function recentReaders(store: Store, names: readonly string[]): RunRecord[] {
  if (!names.length) return [];
  const ids = store.query(
    `SELECT r.run_id AS id FROM runs r WHERE r.run_id IN (
       SELECT run_id FROM runs WHERE status != 'running' AND parent_run_id IS NULL ORDER BY started_at DESC LIMIT ${RECENT}
     ) AND EXISTS (SELECT 1 FROM call_events c WHERE c.run_id = r.run_id AND c.phase = 'start' AND c.kind = 'tool' AND c.name IN (${names.map(() => '?').join(', ')}))
     ORDER BY r.started_at DESC, r.run_id DESC`,
    ...names,
  );
  return ids.map((r) => store.getRun(String(r.id))).filter((r): r is RunRecord => !!r && hasRecordedCommand(r));
}

/**
 * For each untrusted read's tool (`names`), the run its Run injection test… tests: the newest golden's
 * recording that reads it (Security's rows), else the newest ended recording of the store that does.
 * None where neither reads it.
 */
export async function toolTests(store: Store, names: readonly string[], security: SecurityRead, o: InjectionReadInput): Promise<Record<string, ToolTest>> {
  const out: Record<string, ToolTest> = {};
  const left = new Set(names);
  for (const g of security.goldens) {
    for (const r of g.reads) {
      if (!left.delete(r.name)) continue;
      out[r.name] = { runId: g.runId, golden: g.runId ? null : g.path, whose: `${g.name}’s recording`, reads: g.reads, estimate: g.estimate };
    }
  }
  for (const run of recentReaders(store, [...left])) {
    if (!left.size) break;
    const read = await readsOf(store, run, o);
    for (const r of read.reads) {
      if (!left.delete(r.name)) continue;
      out[r.name] = { runId: run.runId, golden: null, whose: run.runId.slice(0, 10), reads: read.reads, estimate: read.estimate };
    }
  }
  return out;
}

/** Tests' Security, read beside the server. */
export type SecurityJob = { kind: 'injection-security' } & InjectionReadInput;

/** Settings → Tools' store reads (tool-reads.ts), each tool's trust (injection.ts toolTrust), and the run each untrusted read's test runs on. */
export type ToolsReadJob = { kind: 'tools-read' } & InjectionReadInput;

/** What Settings → Tools reads of the store in one pooled job. */
export interface ToolsRead extends ToolReads {
  trust: ToolTrustRow[];
  tests: Record<string, ToolTest>;
}

/** The reads whose names Security's and Tools' rows test: a read (never a pure tool, a person's input or a write) marked untrusted. */
async function toolsRead(store: Store, job: InjectionReadInput): Promise<ToolsRead> {
  const reads = toolReads(store);
  const { tools: trust } = toolTrust(store, job.tools);
  const effects = new Map(reads.usage.map((u) => [u.name, u.effect]));
  const untrusted = trust.filter((t) => t.trust === 'untrusted' && !t.input && effects.get(t.name) === 'read').map((t) => t.name);
  const tests = untrusted.length ? await toolTests(store, untrusted, await injectionSecurity(store, job), job) : {};
  return { ...reads, trust, tests };
}

export const INJECTION_READS: ReadTable<SecurityJob | ToolsReadJob> = {
  'injection-security': async (store, job) => answer(await injectionSecurity(store, job), { tagged: true }),
  'tools-read': async (store, job) => answer(await toolsRead(store, job), { tagged: true }),
};
