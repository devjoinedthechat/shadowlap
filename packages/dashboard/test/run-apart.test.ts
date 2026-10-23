import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previewRedaction, Store, storeApiRequest, type CallMeta, type Normalizer } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';
import { EXPORT_LIMITS, ExportError, exportHtmlApart, exportTookTooLong } from '../src/export-apart.js';
import { PREVIEW_LIMITS } from '../src/redaction-preview.js';
import { MASK_BUSY, MASK_WAIT, maskCount } from '../src/run-mask.js';

/**
 * What a run's page reads that applies the project's redaction rules to everything the run holds:
 * the HTML download and what Provenance says a copy would mask. Both are worked out on a thread of
 * their own against the store file, so a long run or a rule that takes minutes on the run's text
 * never holds up the dashboard server. The threads start from the built dashboard (npm run build).
 */

let project: string;
let dbPath: string;
let store: Store;
let dash: Dashboard | null = null;
const savedPreview = { ...PREVIEW_LIMITS };
const savedExport = { ...EXPORT_LIMITS };
const savedWait = { ...MASK_WAIT };

const EMAIL: Normalizer = { pattern: 'email', replace: '<EMAIL>' };
/**
 * A pattern the engine's pattern check takes (no exponential backtracking), whose time still grows
 * with the cube of a text it reads: minutes on SLOW_TEXT, an x every other character and no y.
 */
const SLOW: Normalizer = { pattern: '/\\w*x\\w*y/', replace: '<A>' };
const SLOW_TEXT = 'ax'.repeat(3000);

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-run-apart-')));
  mkdirSync(join(project, '.shadowlap'));
  dbPath = join(project, '.shadowlap', 'shadowlap.db');
  store = Store.open(dbPath);
});
afterEach(async () => {
  Object.assign(PREVIEW_LIMITS, savedPreview);
  Object.assign(EXPORT_LIMITS, savedExport);
  Object.assign(MASK_WAIT, savedWait);
  await dash?.close();
  dash = null;
  store.close();
  rmSync(project, { recursive: true, force: true });
});

function recording(o: { ended?: boolean } = {}) {
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: project } });
  if (o.ended !== false) store.endRun(run.runId, 'completed');
  return run;
}

/** Its recorder was killed: the store still names the process, and it is gone. */
function leave(runId: string) {
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE run_owners SET pid = ? WHERE run_id = ?').run(spawnSync(process.execPath, ['-e', '0']).pid!, runId);
  db.close();
}

/** A model call whose request and answer hold `text`, the user's message sent again by each later call. */
function modelCall(runId: string, callNo: number, text: string) {
  const body = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: `Refund for ${text}` }] };
  const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `m${callNo}`.padEnd(64, '0'), occurrence: 1 };
  const meta: CallMeta = {};
  store.appendCallStart({ runId, callNo, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, body), meta, at: callNo });
  store.appendCallEnd(id, { runId, callNo, attempt: 0, responseRef: store.putBlob(Buffer.from(JSON.stringify({ content: [{ type: 'text', text: `Refunded ${text}` }] }))), outcome: 'ok', meta: {}, at: callNo + 1 });
}

async function serve(redact: Normalizer[]): Promise<Dashboard> {
  dash = await startDashboard({ store, dbPath, redact, project: { path: project } });
  return dash;
}

const api = (d: Dashboard, path: string) => fetch(`${d.url}/api/${path}`, { headers: { 'x-shadowlap-token': d.token } });
const error = async (res: Response) => ((await res.json()) as { error: string }).error;

describe('what a copy of a run would mask, on its Provenance', () => {
  it('counts as the Redaction tab’s preview does, each value once, on a thread of its own', async () => {
    const run = recording();
    modelCall(run.runId, 1, 'jane@example.com');
    modelCall(run.runId, 2, 'jane@example.com');
    modelCall(run.runId, 3, 'omar@example.com');
    const preview = previewRedaction(store, run.runId, [EMAIL]).total;
    expect(await maskCount({ store, dbPath, run, rules: [EMAIL] })).toEqual({ rules: 1, values: preview });
    // Read here when the store has no file of its own; nothing to count without rules.
    expect(await maskCount({ store, dbPath: ':memory:', run, rules: [EMAIL] })).toEqual({ rules: 1, values: preview });
    expect(await maskCount({ store, dbPath, run, rules: [] })).toEqual({ rules: 0, values: 0 });
    const d = await serve([EMAIL]);
    const p = (await (await api(d, `runs/${run.runId}/provenance`)).json()) as { mask: { rules: number; values: number | null } };
    expect(p.mask).toEqual({ rules: 1, values: preview });
  });

  it('says how many more the rules match that a copy leaves as they are, as the preview does', async () => {
    const run = recording();
    const id = { kind: 'tool' as const, name: 'lookup_card', fingerprint: 'c'.repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: 1, ...id, origin: 'live', effect: 'read', requestRef: store.putJson({ args: { customer: 'jane@example.com' } }), meta: {}, at: 1 });
    store.appendCallEnd(id, { runId: run.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from('{"result":{"card":4111111111111111,"at":1792155242516}}')), outcome: 'ok', meta: {}, at: 2 });
    const CARD: Normalizer = { pattern: '/\\b(?:\\d[ -]?){13,16}\\b/', replace: '<CARD>' };
    expect(await maskCount({ store, dbPath, run, rules: [EMAIL, CARD] })).toEqual({ rules: 2, values: 1, unmasked: 2 });
    const d = await serve([EMAIL, CARD]);
    const p = (await (await api(d, `runs/${run.runId}/provenance`)).json()) as { mask: { rules: number; values: number | null; unmasked?: number } };
    expect(p.mask).toEqual({ rules: 2, values: 1, unmasked: 2 });
    // A path rule on the card the tool returned: a pack keeps it, export html and dataset mask it.
    const READ: Normalizer = { kind: 'tool', name: 'lookup_card', path: '$.result.card', replace: '<CARD>' };
    expect(await maskCount({ store, dbPath, run, rules: [EMAIL, CARD, READ] })).toEqual({ rules: 3, values: 1, returned: 1, unmasked: 2 });
  });

  it('leaves it uncounted, saying why, when a rule takes too long, and answers everything else meanwhile', async () => {
    const run = recording();
    modelCall(run.runId, 1, SLOW_TEXT);
    // The rule runs for minutes, so only the hard limit ends the count, 5 s after its thread opened the
    // store: the order of the two answers below is checked within that limit, which leaves a slow
    // machine seconds to ask meta and answer it.
    Object.assign(PREVIEW_LIMITS, { softMs: 200, hardMs: 5000 });
    const d = await serve([EMAIL, SLOW]);
    let counted = false;
    const asked = api(d, `runs/${run.runId}/provenance`).finally(() => (counted = true));
    await new Promise((r) => setTimeout(r, 300));
    // The server's own thread is free: it answers while the count runs.
    expect((await api(d, 'meta')).status).toBe(200);
    expect(counted, 'the server answered only once the count was over').toBe(false);
    const res = await asked;
    expect(res.status).toBe(200);
    const p = (await res.json()) as { mask: { rules: number; values: number | null; why?: string } };
    expect(p.mask.rules).toBe(2);
    expect(p.mask.values).toBeNull();
    expect(p.mask.why).toMatch(/a rule takes that long on this run’s text, and would in a pack too/);
  });

  it('counts nothing while the run records: a copy is made once it has ended', async () => {
    const run = recording({ ended: false });
    modelCall(run.runId, 1, 'jane@example.com');
    expect(await maskCount({ store, dbPath, run, rules: [EMAIL] })).toEqual({ rules: 1, values: null });
  });

  it('counts one run after another, never turning one away because another is being counted', async () => {
    const runs = [recording(), recording(), recording(), recording()];
    runs.forEach((run, i) => modelCall(run.runId, 1, `user${i}@example.com`));
    // One preview thread: the four counts take it in turn.
    const limits = { ...PREVIEW_LIMITS, workers: 1 };
    const counts = await Promise.all(runs.map((run) => maskCount({ store, dbPath, run, rules: [EMAIL], limits })));
    expect(counts).toEqual(runs.map(() => ({ rules: 1, values: 2 })));
  });

  it('waits for a thread while the Redaction tab’s previews hold them, and says it is still to come past its wait', async () => {
    const run = recording();
    modelCall(run.runId, 1, 'jane@example.com');
    const held = { ...PREVIEW_LIMITS, workers: 0 };
    Object.assign(MASK_WAIT, { totalMs: 600, everyMs: 50 });
    const waiting = maskCount({ store, dbPath, run, rules: [EMAIL], limits: held });
    // A thread comes free while it waits.
    setTimeout(() => (held.workers = 2), 200);
    expect(await waiting).toEqual({ rules: 1, values: 2 });
    // None does: it says so, and the page asks again.
    held.workers = 0;
    expect(await maskCount({ store, dbPath, run, rules: [EMAIL], limits: held })).toEqual({ rules: 1, values: null, why: MASK_BUSY, busy: true });
  });

  it('counts a run whose recorder was killed, as one that ended', async () => {
    const run = recording({ ended: false });
    modelCall(run.runId, 1, 'jane@example.com');
    leave(run.runId);
    expect(await maskCount({ store, dbPath, run: store.getRun(run.runId)!, rules: [EMAIL] })).toEqual({ rules: 1, values: 2 });
  });
});

describe('the HTML download', () => {
  it('is made on a thread of its own, as export html --lineage makes it, redacted', async () => {
    const run = recording();
    modelCall(run.runId, 1, 'jane@example.com');
    const out = await exportHtmlApart({ dbPath, runIds: [run.runId], redact: [EMAIL], version: '9.9.9' });
    expect(out).toMatchObject({ runIds: [run.runId], calls: 1, redacted: true });
    expect(out.html).toContain('<EMAIL>');
    expect(out.html).not.toContain('jane@example.com');
    const d = await serve([EMAIL]);
    const res = await api(d, `runs/${run.runId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="shadowlap-${run.runId.slice(0, 10).toLowerCase()}.html"`);
    expect(res.headers.get('x-shadowlap-redacted')).toBe('yes');
    const html = await res.text();
    expect(html).toContain(run.runId);
    expect(html).not.toContain('jane@example.com');
  });

  it('is stopped when a rule takes too long, naming the rule, and the server answers meanwhile', async () => {
    const run = recording();
    modelCall(run.runId, 1, SLOW_TEXT);
    // The rule runs for minutes, so only the hard limit ends the file, 5 s after its thread opened the
    // store: the order of the two answers below is checked within that limit, which leaves a slow
    // machine seconds to ask meta and answer it.
    EXPORT_LIMITS.hardMs = 5000;
    const d = await serve([EMAIL, SLOW]);
    let made = false;
    const asked = api(d, `runs/${run.runId}/export`).finally(() => (made = true));
    await new Promise((r) => setTimeout(r, 300));
    // The server's own thread is free: it answers while the file is made.
    expect((await api(d, 'meta')).status).toBe(200);
    expect(made, 'the server answered only once the file was stopped').toBe(false);
    const res = await asked;
    expect(res.status).toBe(422);
    expect(await error(res)).toBe(`Making the HTML file took longer than 5 s, so it was stopped. A redaction rule may take that long on this run’s text, or the run is too long for a download: shadowlap export html ${run.runId.slice(0, 10)} --lineage makes the file from a terminal.`);
  });

  it('waits for a run still recording, and for a thread when every one is busy', async () => {
    const live = recording({ ended: false });
    modelCall(live.runId, 1, 'jane@example.com');
    const d = await serve([EMAIL]);
    const res = await api(d, `runs/${live.runId}/export`);
    expect(res.status).toBe(409);
    expect(await error(res)).toBe(`${live.runId.slice(0, 10)} is still recording: copy it once it has ended`);
    await expect(exportHtmlApart({ dbPath, runIds: [live.runId], redact: [], version: null }, { limits: { ...EXPORT_LIMITS, workers: 0 } })).rejects.toMatchObject({ status: 503 });
    expect(new ExportError(503, 'x')).toBeInstanceOf(Error);
  });

  it('shows a run whose recorder was killed as interrupted, never recording', async () => {
    const run = recording({ ended: false });
    modelCall(run.runId, 1, 'jane@example.com');
    leave(run.runId);
    for (const redact of [[EMAIL], []]) {
      const d = await serve(redact);
      const res = await api(d, `runs/${run.runId}/export`);
      expect(res.status).toBe(200);
      const html = await res.text();
      const data = JSON.parse(/<script type="application\/json" id="shadowlap-data">(.*?)<\/script>/s.exec(html)![1]!.split('<\\/').join('</')) as { responses: Record<string, { run?: { status: string; endedAt: number | null } }> };
      // Ended at its last sign of life: its calls here are stamped before it started.
      expect(data.responses[`runs/${run.runId}`]!.run, `${redact.length} rules`).toMatchObject({ status: 'crashed', endedAt: run.startedAt });
      await dash?.close();
      dash = null;
    }
    expect(store.getRun(run.runId)!.status).toBe('running');
  });

  it('says what to do when no rule has the shape of a slow one', () => {
    expect(exportTookTooLong([EMAIL], 120_000, '01M51X8H8JWJNE1WC28GK204GY')).toBe('Making the HTML file took longer than 2 min, so it was stopped. A redaction rule may take that long on this run’s text, or the run is too long for a download: shadowlap export html 01M51X8H8J --lineage makes the file from a terminal.');
  });
});
