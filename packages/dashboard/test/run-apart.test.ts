import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previewRedaction, Store, storeApiRequest, type CallMeta, type Normalizer } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';
import { EXPORT_LIMITS, ExportError, exportHtmlApart, exportTookTooLong } from '../src/export-apart.js';
import { PREVIEW_LIMITS } from '../src/redaction-preview.js';
import { maskCount } from '../src/run-mask.js';

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

const EMAIL: Normalizer = { pattern: 'email', replace: '<EMAIL>' };
/** A pattern that backtracks for minutes on a long run of `a`s that doesn't end the text. */
const SLOW: Normalizer = { pattern: '/(a+)+$/', replace: '<A>' };

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-run-apart-')));
  mkdirSync(join(project, '.shadowlap'));
  dbPath = join(project, '.shadowlap', 'shadowlap.db');
  store = Store.open(dbPath);
});
afterEach(async () => {
  Object.assign(PREVIEW_LIMITS, savedPreview);
  Object.assign(EXPORT_LIMITS, savedExport);
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

  it('leaves it uncounted, saying why, when a rule takes too long, and answers everything else meanwhile', async () => {
    const run = recording();
    modelCall(run.runId, 1, `${'a'.repeat(40)}!`);
    Object.assign(PREVIEW_LIMITS, { softMs: 200, hardMs: 1000 });
    const d = await serve([EMAIL, SLOW]);
    const asked = api(d, `runs/${run.runId}/provenance`);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    expect((await api(d, 'meta')).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(500);
    const res = await asked;
    expect(res.status).toBe(200);
    const p = (await res.json()) as { mask: { rules: number; values: number | null; why?: string } };
    expect(p.mask.rules).toBe(2);
    expect(p.mask.values).toBeNull();
    expect(p.mask.why).toMatch(/Rule #2, \/\(a\+\)\+\$\/, repeats a group that repeats itself/);
  });

  it('counts nothing while the run records: a copy is made once it has ended', async () => {
    const run = recording({ ended: false });
    modelCall(run.runId, 1, 'jane@example.com');
    expect(await maskCount({ store, dbPath, run, rules: [EMAIL] })).toEqual({ rules: 1, values: null });
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
    modelCall(run.runId, 1, `${'a'.repeat(40)}!`);
    EXPORT_LIMITS.hardMs = 1000;
    const d = await serve([EMAIL, SLOW]);
    const asked = api(d, `runs/${run.runId}/export`);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    expect((await api(d, 'meta')).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(500);
    const res = await asked;
    expect(res.status).toBe(422);
    expect(await error(res)).toBe('Making the HTML file took longer than 1 s, so it was stopped. Redaction rule #2, /(a+)+$/, repeats a group that repeats itself, which can take minutes on some text: write it without the outer repeat.');
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

  it('says what to do when no rule has the shape of a slow one', () => {
    expect(exportTookTooLong([EMAIL], 120_000, '01M51X8H8JWJNE1WC28GK204GY')).toBe('Making the HTML file took longer than 2 min, so it was stopped. A redaction rule may take that long on this run’s text, or the run is too long for a download: shadowlap export html 01M51X8H8J --lineage makes the file from a terminal.');
  });
});
