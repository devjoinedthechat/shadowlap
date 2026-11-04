import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store, type Normalizer } from '@shadowlap/engine';
import { cliSpawner, runDetail, showRunJson, startDashboard, type Dashboard, type JobView } from '../src/index.js';
import { collectorUrl, copyRules, exportDatasetJob, exportHarJob, exportHtmlJob, exportOtelJob, inStoreFolder, insideProject, MAX_PACK_RUNS, packFolder, packFolders, packJob, traceFile } from '../src/run-exports.js';
import { blameOffer, goldenExpect, passingBisect, runOffers, sameCommit, testOffer } from '../src/run-offers.js';
import { addRun, blameOf } from './read-model-store.js';
import { RunBuilder } from '../../engine/test/run-fixtures.js';

/**
 * The run page's Share menu and what it offers: the export jobs (each builds its command from checked
 * fields and writes into the project folder), how many redaction rules each copy applies, whether a
 * run is only on this machine, and whether Run blame applies with the check it would likely use.
 */

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const T0 = 1_790_000_000_000;

let project: string;
let outside: string;
let store: Store;

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-share-project-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'sl-share-outside-')));
  store = Store.open(':memory:');
});
afterAll(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const proj = () => ({ name: 'demo', path: project });

/** A run its recorder was killed in: still marked running, with no process recording it. */
function abandoned(startedAt: number): string {
  const runId = `01K4ZZ${String(startedAt).slice(-8)}LEFT`.padEnd(26, '0').slice(0, 26);
  store.importRun({ runId, parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: project }, codeVersion: null, startedAt, endedAt: null });
  return runId;
}

describe('the Share menu’s jobs', () => {
  it('writes HTML and HAR into .shadowlap/exports, with the runs it came from in the HTML', () => {
    const id = addRun(store, { startedAt: T0, calls: 'll' });
    const html = exportHtmlJob(store, proj(), { runId: id.slice(0, 10) });
    expect(html).toEqual({ args: ['export', 'html', id, `.shadowlap/exports/shadowlap-${id.slice(0, 10).toLowerCase()}.html`, '--lineage'], runId: id, title: 'Exporting HTML report' });
    expect(exportHarJob(store, proj(), { runId: id })).toEqual({ args: ['export', 'har', id, `.shadowlap/exports/${id.slice(0, 10).toLowerCase()}.har`], runId: id, title: 'Exporting HAR file' });
    // The folder is there for the CLI to write into.
    expect(() => readFileSync(join(project, '.shadowlap', 'exports'))).toThrow(/EISDIR/);
    expect(exportHtmlJob(store, proj(), {})).toMatchObject({ error: 'runId is required' });
    expect(exportHtmlJob(store, proj(), { runId: 'ZZZZZZ' })).toMatchObject({ error: 'no run ZZZZZZ', status: 404 });
    expect(exportHtmlJob(store, null, { runId: id })).toMatchObject({ status: 501 });
  });

  it('packs into a folder inside the project, never outside it or into the store’s own folder', () => {
    const id = addRun(store, { startedAt: T0 + 1, calls: 'l' });
    const low = id.slice(0, 10).toLowerCase();
    expect(packJob(store, proj(), { runId: id })).toEqual({ args: ['pack', id, `./.shadowlap/exports/${low}`], runId: id, title: 'Packing' });
    expect(packJob(store, proj(), { runId: id, dir: 'goldens/refund' })).toMatchObject({ args: ['pack', id, './goldens/refund'] });
    // A folder that reads like an option is still a folder.
    expect(packJob(store, proj(), { runId: id, dir: '--no-redact' })).toMatchObject({ args: ['pack', id, './--no-redact'] });
    for (const dir of ['../elsewhere', '/tmp/x', 'share/../../x', '.shadowlap', '.shadowlap/blobs', '', '  ', 7]) expect(packJob(store, proj(), { runId: id, dir })).toHaveProperty('error');
    // A folder that is a link out of the project.
    symlinkSync(outside, join(project, 'escape'));
    expect(packFolder(project, 'escape/pack')).toHaveProperty('error');
    expect(insideProject(project, 'escape')).toBe(false);
    expect(insideProject(project, 'share/new/deeper')).toBe(true);
  });

  it('packs the runs the Runs page picked in one job, a folder each inside the folder its dialog names', () => {
    const a = addRun(store, { startedAt: T0 + 10, calls: 'l' });
    const b = addRun(store, { startedAt: T0 + 11, calls: 'l' });
    const low = (id: string) => id.slice(0, 10).toLowerCase();
    // Into .shadowlap/exports unless asked, never the project's own root: one pack after another,
    // so the job's drawer lists every folder.
    expect(packJob(store, proj(), { runIds: [a, b, a] })).toEqual({
      args: ['pack', a, `./.shadowlap/exports/${low(a)}`],
      then: [['pack', b, `./.shadowlap/exports/${low(b)}`]],
      runId: null,
      title: 'Packing 2 runs',
    });
    expect(packJob(store, proj(), { runIds: [a, b], dir: 'goldens/' })).toMatchObject({ args: ['pack', a, `./goldens/${low(a)}`], then: [['pack', b, `./goldens/${low(b)}`]] });
    expect(packJob(store, proj(), { runIds: [b] })).toEqual({ args: ['pack', b, `./.shadowlap/exports/${low(b)}`], runId: b, title: 'Packing' });
    for (const dir of ['../elsewhere', '/tmp/x', '.shadowlap', '', '  ', 7]) expect(packJob(store, proj(), { runIds: [a, b], dir }), String(dir)).toHaveProperty('error');
    expect(packJob(store, proj(), { runIds: [] })).toHaveProperty('error');
    expect(packJob(store, proj(), { runIds: ['--all'] })).toHaveProperty('error');
    expect(packJob(store, proj(), { runIds: Array.from({ length: MAX_PACK_RUNS + 1 }, () => a) })).toMatchObject({ error: `at most ${MAX_PACK_RUNS} runs in one pack job` });
    // Two runs that started in the same millisecond share the first ten characters of their ids: each keeps a folder of its own.
    expect(packFolders(['01K5CQ4N7G0000000000000001', '01K5CQ4N7G0000000000000002', '01K5CQ4N9A0000000000000000'], '.shadowlap/exports/')).toEqual([
      { runId: '01K5CQ4N7G0000000000000001', folder: '.shadowlap/exports/01k5cq4n7g0000000000000001' },
      { runId: '01K5CQ4N7G0000000000000002', folder: '.shadowlap/exports/01k5cq4n7g0000000000000002' },
      { runId: '01K5CQ4N9A0000000000000000', folder: '.shadowlap/exports/01k5cq4n9a' },
    ]);
  });

  it('writes a dataset under the name its dialog shows, and refuses a name that is not a file name', () => {
    const a = addRun(store, { startedAt: T0 + 12, calls: 'l' });
    expect(exportDatasetJob(store, proj(), { runIds: [a], out: 'dataset-2-runs-20261022-074812.jsonl' })).toMatchObject({ args: ['export', 'dataset', a, '--calls', 'final', '--format', 'jsonl', '--out', '.shadowlap/exports/dataset-2-runs-20261022-074812.jsonl'] });
    for (const out of ['../x.jsonl', '/tmp/x.jsonl', '-x', 'a b.jsonl', 7]) expect(exportDatasetJob(store, proj(), { runIds: [a], out }), String(out)).toHaveProperty('error');
  });

  it('exports a dataset of one run or many, in a format and with the examples asked for', () => {
    const a = addRun(store, { startedAt: T0 + 2, calls: 'l' });
    const b = addRun(store, { startedAt: T0 + 3, calls: 'l' });
    expect(exportDatasetJob(store, proj(), { runIds: [a], format: 'braintrust', calls: 'model' })).toEqual({
      args: ['export', 'dataset', a, '--calls', 'model', '--format', 'braintrust', '--out', `.shadowlap/exports/dataset-${a.slice(0, 10).toLowerCase()}.jsonl`],
      runId: a,
      title: 'Exporting dataset',
    });
    const both = exportDatasetJob(store, proj(), { runIds: [a, b, a.slice(0, 12)] }, new Date('2026-10-15T09:41:07Z'));
    expect(both).toMatchObject({ args: ['export', 'dataset', a, b, '--calls', 'final', '--format', 'jsonl', '--out', '.shadowlap/exports/dataset-2-runs-20261015-094107.jsonl'], runId: null });
    expect(exportDatasetJob(store, proj(), { runIds: [a], format: 'csv' })).toHaveProperty('error');
    expect(exportDatasetJob(store, proj(), { runIds: [a], calls: 'all' })).toHaveProperty('error');
    expect(exportDatasetJob(store, proj(), { runIds: ['--all'] })).toHaveProperty('error');
    expect(exportDatasetJob(store, proj(), { runIds: [] })).toHaveProperty('error');
  });

  it('sends a trace to a collector, or writes it into .shadowlap/exports', () => {
    const id = addRun(store, { startedAt: T0 + 4, calls: 'l' });
    expect(exportOtelJob(store, proj(), { runId: id, endpoint: 'http://localhost:4318/' })).toEqual({ args: ['export', 'otel', id, '--endpoint', 'http://localhost:4318'], runId: id, title: 'Exporting trace' });
    expect(exportOtelJob(store, proj(), { runId: id, out: 'trace.json' })).toMatchObject({ args: ['export', 'otel', id, '--out', '.shadowlap/exports/trace.json'] });
    expect(exportOtelJob(store, proj(), { runId: id })).toMatchObject({ args: ['export', 'otel', id, '--out', `.shadowlap/exports/${id.slice(0, 10).toLowerCase()}.otel.json`] });
    // Only the file's name is kept: it lands in the exports folder whatever path was typed.
    expect(traceFile('../../etc/trace.json', id)).toBe('trace.json');
    expect(traceFile('-x', id)).toBeNull();
    expect(collectorUrl('file:///etc/passwd')).toBeNull();
    expect(collectorUrl('--endpoint')).toBeNull();
    expect(exportOtelJob(store, proj(), { runId: id, endpoint: 'ftp://x' })).toHaveProperty('error');
  });

  it('counts the redaction rules each copy applies (decision 6)', () => {
    const rules: Normalizer[] = [{ pattern: 'email', replace: '<email>' }, { path: '$.metadata.user_id', replace: '<user>' }, { pattern: 'uuid', replace: '<id>', kind: 'api' }];
    const c = copyRules(rules);
    expect(c).toMatchObject({ total: 3, pathless: 2 });
    expect(Object.fromEntries(c.formats.map((f) => [f.id, [f.applies, f.rules]]))).toEqual({ html: ['all', 3], pack: ['all', 3], dataset: ['messages', 3], otel: ['attributes', 2], har: ['all', 3] });
    expect(copyRules([]).formats.every((f) => f.rules === 0)).toBe(true);
  });

  it('copies a run once it has ended: a copy of one still recording would never end', () => {
    const live = addRun(store, { startedAt: T0 + 5, calls: 'll', status: 'running' });
    const refused = { error: `${live.slice(0, 10)} is still recording: copy it once it has ended`, status: 409 };
    expect(exportHtmlJob(store, proj(), { runId: live })).toEqual(refused);
    expect(exportHarJob(store, proj(), { runId: live })).toEqual(refused);
    expect(packJob(store, proj(), { runId: live })).toEqual(refused);
    expect(exportOtelJob(store, proj(), { runId: live, out: 'trace.json' })).toEqual(refused);
    expect(exportOtelJob(store, proj(), { runId: live, endpoint: 'http://localhost:4318' })).toEqual(refused);
    // One recording among the runs of a dataset stops it, naming that run.
    const ended = addRun(store, { startedAt: T0 + 6, calls: 'l' });
    expect(exportDatasetJob(store, proj(), { runIds: [ended, live] })).toEqual(refused);
    // A run its recorder left marked running was interrupted, as every list shows it: nothing will
    // add to it, so it is copied as it is, as the CLI copies it.
    const left = abandoned(T0 + 7);
    expect(exportHtmlJob(store, proj(), { runId: left })).toMatchObject({ args: ['export', 'html', left, expect.any(String), '--lineage'] });
    expect(packJob(store, proj(), { runId: left })).toMatchObject({ args: ['pack', left, expect.any(String)] });
    expect(exportDatasetJob(store, proj(), { runIds: [ended, left] })).toMatchObject({ args: expect.arrayContaining([ended, left]) });
  });

  it('never packs into the store’s own folder, however its name is cased or whatever link leads there', () => {
    mkdirSync(join(project, '.shadowlap'), { recursive: true });
    expect(inStoreFolder('.shadowlap')).toBe(true);
    expect(inStoreFolder('.shadowlap/blobs')).toBe(true);
    expect(inStoreFolder('.shadowlap/exports')).toBe(true);
    expect(inStoreFolder('.shadowlap/exports/run')).toBe(false);
    expect(inStoreFolder('share/.shadowlap')).toBe(false);
    // macOS and Windows take another case for the same folder.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      for (const dir of ['.SHADOWLAP', '.Shadowlap/packs', '.shadowLAP/blobs']) expect(packFolder(project, dir), dir).toEqual({ error: "the store's own folder takes no packs: use .shadowlap/exports/ or a folder of your own" });
      expect(packFolder(project, '.Shadowlap/Exports/run')).toBe('./.Shadowlap/Exports/run');
    }
    // A folder of the project that is a link to the store's.
    symlinkSync(join(project, '.shadowlap'), join(project, 'store-link'));
    expect(packFolder(project, 'store-link/run')).toHaveProperty('error', "the store's own folder takes no packs: use .shadowlap/exports/ or a folder of your own");
    // A link that leads nowhere leads outside.
    symlinkSync(join(outside, 'missing'), join(project, 'dangling'));
    expect(packFolder(project, 'dangling/run')).toEqual({ error: 'that folder leads outside the project' });
    expect(insideProject(project, 'dangling')).toBe(false);
  });

  it('never writes a copy through a link, or over something that is not a file', () => {
    const id = addRun(store, { startedAt: T0 + 7, calls: 'l' });
    const low = id.slice(0, 10).toLowerCase();
    const exportsDir = join(project, '.shadowlap', 'exports');
    mkdirSync(exportsDir, { recursive: true });
    const target = join(outside, 'authorized_keys');
    writeFileSync(target, 'keep me\n');
    // A trace's name, and the HTML and HAR names, which follow from the run id.
    symlinkSync(target, join(exportsDir, 'trace.json'));
    symlinkSync(target, join(exportsDir, `shadowlap-${low}.html`));
    symlinkSync(target, join(exportsDir, `${low}.har`));
    symlinkSync(target, join(exportsDir, `dataset-${low}.jsonl`));
    const link = (rel: string) => ({ error: `${rel} is a link, and a copy is never written through one: remove it, or use another name`, status: 409 });
    expect(exportOtelJob(store, proj(), { runId: id, out: 'trace.json' })).toEqual(link('.shadowlap/exports/trace.json'));
    expect(exportHtmlJob(store, proj(), { runId: id })).toEqual(link(`.shadowlap/exports/shadowlap-${low}.html`));
    expect(exportHarJob(store, proj(), { runId: id })).toEqual(link(`.shadowlap/exports/${low}.har`));
    expect(exportDatasetJob(store, proj(), { runIds: [id] })).toEqual(link(`.shadowlap/exports/dataset-${low}.jsonl`));
    // A folder where the file would go.
    mkdirSync(join(exportsDir, 'folder.json'));
    expect(exportOtelJob(store, proj(), { runId: id, out: 'folder.json' })).toEqual({ error: '.shadowlap/exports/folder.json is there already, and it is not a file', status: 409 });
    // A plain file is replaced, as the CLI replaces it.
    writeFileSync(join(exportsDir, 'plain.json'), '{}');
    expect(exportOtelJob(store, proj(), { runId: id, out: 'plain.json' })).toMatchObject({ args: ['export', 'otel', id, '--out', '.shadowlap/exports/plain.json'] });
    // A pack's own files: run.json, calls.jsonl and each blob.
    for (const [name, make] of [
      ['run.json', (dir: string) => symlinkSync(target, join(dir, 'run.json'))],
      ['calls.jsonl', (dir: string) => symlinkSync(target, join(dir, 'calls.jsonl'))],
      ['blobs', (dir: string) => symlinkSync(outside, join(dir, 'blobs'))],
      ['blobs/ab12', (dir: string) => (mkdirSync(join(dir, 'blobs')), symlinkSync(target, join(dir, 'blobs', 'ab12')))],
    ] as const) {
      const dir = join(project, 'packs', name.replace('/', '-'));
      mkdirSync(dir, { recursive: true });
      make(dir);
      const out = packJob(store, proj(), { runId: id, dir: `packs/${name.replace('/', '-')}` });
      expect(out, name).toMatchObject({ status: 409 });
      expect((out as { error: string }).error, name).toContain(`packs/${name.replace('/', '-')}/${name === 'blobs/ab12' ? 'blobs/ab12' : name}`);
    }
    expect(readFileSync(target, 'utf8')).toBe('keep me\n');
    // An existing pack of plain files is packed over.
    mkdirSync(join(project, 'packs', 'again', 'blobs'), { recursive: true });
    writeFileSync(join(project, 'packs', 'again', 'run.json'), '{}');
    writeFileSync(join(project, 'packs', 'again', 'blobs', 'cd34'), 'x');
    expect(packJob(store, proj(), { runId: id, dir: 'packs/again' })).toMatchObject({ args: ['pack', id, './packs/again'] });
  });
});

describe('what the run page offers', () => {
  it('says whether a run is only on this machine, queued, or in the team store', () => {
    const local = addRun(store, { startedAt: T0 + 10, calls: 'l' });
    const pushed = addRun(store, { startedAt: T0 + 11, calls: 'l' });
    const queued = addRun(store, { startedAt: T0 + 12, calls: 'l' });
    const fromPr = addRun(store, { startedAt: T0 + 13, calls: 'l', meta: { imported: { at: T0, from: 'store', pr: '138' } } });
    const live = addRun(store, { startedAt: T0 + 14, calls: 'l', status: 'running' });
    const url = 's3://northwind-agent-runs/support-agent';
    store.setTeamRun(url, { runId: pushed, state: 'pushed', at: T0, base: null, baseHash: null, remoteHash: 'h1', entry: null });
    store.setTeamRun(url, { runId: queued, state: 'queued', at: T0, base: null, baseHash: null, remoteHash: null, entry: null });
    const team = (id: string) => runOffers(store, id, { redact: [], config: { store: url } })!.team;
    expect(team(local)).toEqual({ store: 'northwind-agent-runs/support-agent', state: 'only-here' });
    expect(team(pushed)!.state).toBe('in-store');
    expect(team(queued)!.state).toBe('queued');
    expect(team(fromPr)!.state).toBe('pull-request');
    expect(team(live)!.state).toBe('recording');
    // One its recorder left marked running was interrupted: it is only here, and Push sends it as it is.
    expect(team(abandoned(T0 + 15))).toEqual({ store: 'northwind-agent-runs/support-agent', state: 'only-here' });
    expect(runOffers(store, local, { redact: [], config: null })!.team).toBeNull();
    expect(runOffers(store, local, { redact: [], config: { store: 'not a url' } })!.team).toBeNull();
    expect(runOffers(store, 'ZZZZZZZZ', { redact: [], config: null })).toBeNull();
  });

  it('gives Run blame the check the run failed: its own --expect, its golden’s, or asks', () => {
    const own = addRun(store, { startedAt: T0 + 20, calls: 'l', meta: { expect: { tools: { send_email: 0 } }, checks: [{ ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }] } });
    expect(blameOffer(store, store.getRun(own)!, null)).toEqual({ from: 'run', expect: { tools: { send_email: 0 } }, failed: ['send_email called 0 times'] });
    const tested = addRun(store, { startedAt: T0 + 21, calls: 'l', meta: { test: { golden: 'goldens/research', session: 's1' }, checks: [{ ok: false, label: 'send_email called 1 time', detail: 'called 0 times' }] } });
    const tests = { 'goldens/*': { expect: { tools: { send_email: 1 } } } };
    expect(blameOffer(store, store.getRun(tested)!, tests)).toMatchObject({ from: 'golden', expect: { tools: { send_email: 1 } } });
    expect(goldenExpect({ 'goldens/research': { expect: { modelCalls: '<= 3' } }, 'goldens/*': { expect: {} } }, './goldens/research/')).toEqual({ modelCalls: '<= 3' });
    expect(goldenExpect(tests, 'other/research')).toBeUndefined();
    // A check nothing names: the page asks for it.
    const unknown = addRun(store, { startedAt: T0 + 22, calls: 'l', meta: { checks: [{ ok: false, label: 'at most 3 model calls', detail: '5' }] } });
    expect(blameOffer(store, store.getRun(unknown)!, null)).toEqual({ from: 'ask', failed: ['at most 3 model calls'] });
    // An agent that exited with an error: blame on the exit status alone.
    const crashed = addRun(store, { startedAt: T0 + 23, calls: 'l', status: 'failed' });
    expect(blameOffer(store, store.getRun(crashed)!, null)).toEqual({ from: 'exit', expect: null, failed: [] });
    // Nothing to blame: it passed, it was blamed, it is a capture, a probe, or still recording.
    const passed = addRun(store, { startedAt: T0 + 24, calls: 'l', meta: { checks: [{ ok: true, label: 'x', detail: null }] } });
    const blamed = addRun(store, { startedAt: T0 + 25, calls: 'l', status: 'failed', meta: { blame: blameOf(1, null, T0) } });
    const cap = addRun(store, { startedAt: T0 + 26, argv: [NO_COMMAND], status: 'failed', calls: 'l' });
    const probe = addRun(store, { startedAt: T0 + 27, calls: 'l', status: 'failed', meta: { probe: { of: blamed, callNo: 1, passed: false } } });
    // A judge check with no verdict is no failure to blame: no answer of the model's would decide it.
    const unjudged = addRun(store, { startedAt: T0 + 27.5, calls: 'l', meta: { checks: [{ ok: false, status: 'inconclusive', label: 'polite: the judge answers yes to "Is it polite?"', detail: 'not judged: no recorded verdict and the test runs offline' }] } });
    for (const id of [passed, blamed, cap, probe, unjudged]) expect(blameOffer(store, store.getRun(id)!, null)).toBeNull();
  });

  it('offers no Run blame for a run with a check that could not be decided, which blame refuses', () => {
    const judge = { ok: false, status: 'inconclusive' as const, label: 'judge "explains" answers yes', detail: 'not judged: no recorded verdict and no key for anthropic' };
    const unjudged = addRun(store, { startedAt: T0 + 40, calls: 'l', meta: { expect: { tools: { send_email: 0 } }, checks: [judge] } });
    const both = addRun(store, { startedAt: T0 + 41, calls: 'l', meta: { expect: { tools: { send_email: 0 } }, checks: [{ ok: false, status: 'failed' as const, label: 'send_email called 0 times', detail: 'called 1 time' }, judge] } });
    for (const id of [unjudged, both]) expect(blameOffer(store, store.getRun(id)!, null)).toBeNull();
    // Not applicable is no failure, and doesn't keep a real one from being blamed.
    const applies = addRun(store, { startedAt: T0 + 42, calls: 'l', meta: { expect: { tools: { send_email: 0 } }, checks: [{ ok: false, status: 'failed' as const, label: 'send_email called 0 times', detail: 'called 1 time' }, { ok: true, status: 'not-applicable' as const, label: 'when x is called: y called 1 time', detail: 'the condition never held: x was never called' }] } });
    expect(blameOffer(store, store.getRun(applies)!, null)).toEqual({ from: 'run', expect: { tools: { send_email: 0 } }, failed: ['send_email called 0 times'] });
  });

  it('offers Run blame only where a model call can be blamed, and never on a run that was stopped', () => {
    // Exited before its first model call, or made only tool calls: no answer of the model's to blame.
    const early = addRun(store, { startedAt: T0 + 28, status: 'failed' });
    const tools = addRun(store, { startedAt: T0 + 29, calls: 'bs', status: 'failed', meta: { checks: [{ ok: false, label: 'x', detail: null }] } });
    for (const id of [early, tools]) expect(blameOffer(store, store.getRun(id)!, null)).toBeNull();
    // Interrupted (stopped, or timed out): blame replays it to see it fail as recorded, and a stop never does.
    const stopped = addRun(store, { startedAt: T0 + 33, calls: 'll', status: 'crashed' });
    expect(blameOffer(store, store.getRun(stopped)!, null)).toBeNull();
    // One that failed a check before it was stopped is blamed on that check.
    const checked = addRun(store, { startedAt: T0 + 35, calls: 'll', status: 'crashed', meta: { checks: [{ ok: false, label: 'send_email called 0 times', detail: null }] } });
    expect(blameOffer(store, store.getRun(checked)!, null)).toEqual({ from: 'ask', failed: ['send_email called 0 times'] });
  });

  it('says the diverged test’s normalizer was added, and links the replay of its golden that passed since', () => {
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/research'] });
    const replay = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.js'], cwd: '/p' }, startedAt: T0 + 100, meta: { test: { golden: 'goldens/research', session: s.sessionId } } });
    store.setDivergence(replay.runId, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, diff: [{ path: '$.metadata.user_id', op: 'changed', before: '3f2a8c1e-1b2c-4d5e-8f90-0a1b2c3d4e5f', after: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' }] });
    store.addTestResult({ sessionId: s.sessionId, golden: 'goldens/research', ok: false, failure: 'diverged', runId: replay.runId, at: T0 + 110 });
    const run = store.getRun(replay.runId)!;
    const rule = { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' };
    expect(testOffer(store, run, undefined)).toMatchObject({ golden: 'goldens/research', normalized: false, passingRun: null });
    expect(testOffer(store, run, [{ ...rule, replace: '<ID>' }])).toMatchObject({ normalized: false });
    // Written in another order, it is the same rule: added, and nothing has passed since.
    expect(testOffer(store, run, [{ replace: '<UUID>', pattern: 'uuid', path: '$.metadata.user_id', kind: 'api' }])).toMatchObject({ normalized: true, passingRun: null });
    // The golden ran again and passed.
    const again = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/research'] });
    const passing = store.createRun({ mode: 'replay', command: { argv: ['node', 'agent.js'], cwd: '/p' }, startedAt: T0 + 200, meta: { test: { golden: 'goldens/research', session: again.sessionId } } });
    store.addTestResult({ sessionId: again.sessionId, golden: 'goldens/research', ok: true, runId: passing.runId, at: T0 + 210 });
    expect(testOffer(store, run, [rule])).toMatchObject({ normalized: true, passingRun: passing.runId });
    expect(runOffers(store, run.runId, { redact: [], config: { normalize: [rule] } })!.test).toMatchObject({ normalized: true, passingRun: passing.runId });
    expect(testOffer(store, store.getRun(passing.runId)!, [rule])).toBeNull();
  });

  it('adds the normalizer and re-runs when the rule alone makes the replay match, and updates the golden after it when it can’t', () => {
    const golden = { path: 'goldens/refund-in-limit', runId: null, packedAt: null, mode: 'replay' as const, repeat: 1, passes: 1, checks: ['issue_refund called 1 time', 'send_email called 1 time'] };
    const diverged = (startedAt: number, diff: Array<{ path: string; op: 'changed' | 'added'; before?: unknown; after?: unknown }>) => {
      const s = store.startTestSession({ command: ['shadowlap', 'test', golden.path] });
      const replay = store.createRun({ mode: 'replay', command: { argv: ['node', 'refund_agent.mjs', 'T-8830'], cwd: '/p' }, startedAt, meta: { test: { golden: golden.path, session: s.sessionId } } });
      store.setDivergence(replay.runId, { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, diff });
      store.addTestResult({ sessionId: s.sessionId, golden: golden.path, ok: false, failure: 'diverged', runId: replay.runId, at: startedAt + 10 });
      return store.getRun(replay.runId)!;
    };
    const add = ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'];
    // A per-run id the recording had too: the rule alone makes the replay match.
    const changed = diverged(T0 + 300, [{ path: '$.metadata.user_id', op: 'changed', before: '3f2a8c1e-1b2c-4d5e-8f90-0a1b2c3d4e5f', after: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' }]);
    expect(testOffer(store, changed, [], [golden])).toMatchObject({ normalizerFixes: true, normalizeAndTest: [add, ['test', golden.path]], checks: golden.checks });
    // A field the recording never had (the demo's refund-in-limit): the golden is updated after the rule.
    const added = diverged(T0 + 400, [{ path: '$.metadata', op: 'added', after: { user_id: '67b47cab-d067-4923-93f8-0006dd89ba21' } }]);
    expect(testOffer(store, added, [], [golden])).toMatchObject({ normalizerFixes: false, volatile: { path: '$.metadata.user_id', op: 'added' }, normalizeAndTest: [add, ['test', golden.path, '--update']] });
    // The checks an update runs are the golden's now; unknown for a golden that isn't on disk.
    expect(runOffers(store, added.runId, { redact: [], config: null, goldens: [golden] })!.test!.checks).toEqual(golden.checks);
    expect(testOffer(store, added, [])!.checks).toBeNull();
  });

  it('offers Find the commit and the diverged test’s actions, from the tests read model', () => {
    const id = addRun(store, { startedAt: T0 + 30, calls: 'l' });
    const o = runOffers(store, id, { redact: [{ pattern: 'email', replace: '<e>' }], config: null })!;
    expect(o.copies.total).toBe(1);
    expect(o.bisect).toMatchObject({ target: { kind: 'run', runId: id }, failed: false });
    expect(o.test).toBeNull();
  });

  it('offers no search after a run that passed at HEAD: there is no later commit yet', () => {
    // Made at a7b3c2e, and it passed: bisect would look from there up to HEAD.
    const id = addRun(store, { startedAt: T0 + 32, calls: 'l' });
    const at = (head: string | null) => runOffers(store, id, { redact: [], config: null, head })!.bisect!;
    expect(at('a7b3c2e9f00d1c2b3a4d5e6f708192a3b4c5d6e7')).toMatchObject({ failed: false, good: 'a7b3c2e', args: null, unavailable: 'this run passed at a7b3c2e, which is HEAD: there is no later commit to search yet' });
    // A commit came since: the search starts at the run's own.
    expect(at('c91d0f4aa00d1c2b3a4d5e6f708192a3b4c5d6e7')).toMatchObject({ failed: false, good: 'a7b3c2e', unavailable: null, args: ['bisect', id, '--good', 'a7b3c2e'] });
    // Outside git, nothing is known of HEAD.
    expect(at(null)).toMatchObject({ unavailable: null });
    // A run that failed is searched from a good commit up to its own, whatever HEAD is.
    const failed = addRun(store, { startedAt: T0 + 34, calls: 'l', status: 'failed' });
    expect(passingBisect(runOffers(store, failed, { redact: [], config: null })!.bisect, 'a7b3c2e')).toMatchObject({ failed: true });
    expect(sameCommit('A7B3C2E', 'a7b3c2e9f00d')).toBe(true);
    expect(sameCommit('a7b3c2', 'a7b3c2e9f00d')).toBe(false);
    expect(sameCommit('v2.4.0', 'v2.4.0')).toBe(true);
    expect(sameCommit('main', 'mainline')).toBe(false);
  });

  it('never bisects a run blame found failing as if it passed', () => {
    // Exited 0 and kept no checks of its own, but blame confirmed it fails the check it was given;
    // its fix, which would name that check, isn't in this store (a pack carries the blame alone).
    // With the fix here, run-find-commit.test.ts searches with its check.
    const id = addRun(store, { startedAt: T0 + 31, calls: 'l', meta: { blame: blameOf(1, null, T0) } });
    expect(runOffers(store, id, { redact: [], config: null })!.bisect).toMatchObject({
      failed: true,
      good: null,
      bad: 'a7b3c2e',
      fork: true,
      args: null,
      unavailable: expect.stringContaining(`shadowlap bisect ${id.slice(0, 10)} --good <commit> --bad a7b3c2e --expect '<checks>' --fork`),
    });
  });
});

describe('the Calls view’s values', () => {
  it('names each model as the page names it: the id without its date stamp, by the short name on its rows', () => {
    const id = addRun(store, { startedAt: T0 + 49, calls: [{ code: 'l', model: 'claude-opus-5-20261001' }, { code: 'l', model: 'claude-opus-5' }, { code: 'l', model: 'us.anthropic.claude-sonnet-5-20261001-v1:0' }, { code: 'l', model: 'gpt-5-mini' }, { code: 'o' }] });
    const d = runDetail(store, id)!;
    expect(d.calls.map((c) => c.model)).toEqual(['opus-5', 'opus-5', 'sonnet-5', 'gpt-5-mini', null]);
    expect(d.models).toEqual({ 'opus-5': 'claude-opus-5', 'sonnet-5': 'claude-sonnet-5', 'gpt-5-mini': 'gpt-5-mini' });
  });

  it('shows a clock read’s and a random value’s value beside the call', () => {
    const b = RunBuilder.start(store, { startedAt: T0 + 50 });
    const id = b.run.runId;
    for (const [kind, value] of [['clock', 1_792_094_173_884], ['random', '7f3c2a1e-9b4d-4c61-a0e2-5d8f1b6c3e90']] as const) {
      const callNo = ++b.callNo;
      const identity = { kind, name: kind === 'clock' ? 'now' : 'uuid', fingerprint: `fp-${callNo}`, occurrence: 1 };
      store.appendCallStart({ runId: id, callNo, ...identity, origin: 'live', effect: null, requestRef: store.putJson({ label: 'start' }), meta: {}, at: T0 + 50 + callNo });
      store.appendCallEnd(identity, { runId: id, callNo, attempt: 0, responseRef: store.putJson({ result: value }), outcome: 'ok', meta: {}, at: T0 + 51 + callNo });
    }
    b.end();
    expect(runDetail(store, id)!.calls.map((c) => c.resultShort)).toEqual(['1792094173884', '"7f3c2a1e-9b4d-4c61-a0e2-5d8f1b6c3e90"']);
  });
});

describe('the run page’s routes', () => {
  let dash: Dashboard;
  let projectDir: string;
  let id: string;
  const spawned: string[][] = [];
  const api = (path: string, init: RequestInit = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  async function waitJob(jobId: string): Promise<JobView> {
    for (let i = 0; i < 200; i++) {
      const view = (await (await api(`jobs/${jobId}`)).json()) as JobView;
      if (view.done) return view;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`job ${jobId} did not finish`);
  }

  beforeAll(async () => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'sl-share-routes-')));
    writeFileSync(join(projectDir, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<email>' }, { path: '$.metadata.user_id', replace: '<user>' }], store: 's3://bucket/team' }));
    id = addRun(store, { startedAt: T0 + 60, calls: 'll' });
    const spawner = cliSpawner({ command: [process.execPath, FAKE], cwd: projectDir });
    dash = await startDashboard({
      store,
      version: '0.1.0',
      dbPath: ':memory:',
      project: { path: projectDir },
      loadConfig: () => ({ normalize: [], redact: JSON.parse(readFileSync(join(projectDir, 'shadowlap.config.json'), 'utf8')).redact as Normalizer[] }),
      spawnCli: (args, options) => {
        spawned.push(args);
        return spawner(args, options);
      },
    });
  });
  afterAll(async () => {
    await dash.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('lists the export kinds, and answers what the page offers for a run', async () => {
    const meta = (await (await api('meta')).json()) as { jobKinds: string[] };
    expect(meta.jobKinds).toEqual(expect.arrayContaining(['export-html', 'pack', 'export-dataset', 'export-otel', 'export-har']));
    const res = await api(`runs/${id.slice(0, 10)}/offers`);
    expect(res.status).toBe(200);
    const o = (await res.json()) as { runId: string; copies: { total: number; formats: Array<{ id: string; rules: number }> }; team: unknown };
    expect(o.runId).toBe(id);
    expect(o.copies.total).toBe(2);
    expect(o.copies.formats.find((f) => f.id === 'otel')!.rules).toBe(1);
    expect(o.team).toEqual({ store: 'bucket/team', state: 'only-here' });
    expect((await api('runs/ZZZZZZZZZZ/offers')).status).toBe(404);
  });

  it('serves show --json as the CLI prints it', async () => {
    const res = await api(`runs/${id}/show`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(showRunJson(store, id))));
    expect((await api('runs/ZZZZZZZZZZ/show')).status).toBe(404);
  });

  it('builds each export on the server and refuses what the browser should not decide', async () => {
    const start = (body: unknown) => api('jobs', { method: 'POST', body: JSON.stringify(body) });
    const html = await start({ kind: 'export-html', runId: id, args: ['rm', id] });
    expect(html.status).toBe(202);
    await waitJob(((await html.json()) as JobView).id);
    expect(spawned.at(-1)).toEqual(['export', 'html', id, `.shadowlap/exports/shadowlap-${id.slice(0, 10).toLowerCase()}.html`, '--lineage']);
    const bad = await start({ kind: 'pack', runId: id, dir: '../../outside' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/inside the project/);
    const otel = await start({ kind: 'export-otel', runId: id, endpoint: 'javascript:alert(1)' });
    expect(otel.status).toBe(400);
  });
});

describe('Push on a run in the store whose attempts are only here', () => {
  it('offers it, as the Runs page tags the run local, and says the attempts are what goes', () => {
    const url = 's3://northwind-agent-runs/support-agent';
    const golden = addRun(store, { startedAt: T0 + 100, calls: 'l' });
    store.setTeamRun(url, { runId: golden, state: 'pushed', at: T0, base: null, baseHash: null, remoteHash: 'h1', entry: null });
    const team = () => runOffers(store, golden, { redact: [], config: { store: url } })!.team;
    expect(team()).toEqual({ store: 'northwind-agent-runs/support-agent', state: 'in-store' });
    // replay --repeat 2 since the push: the run is in the store, its two attempts aren't.
    const attempts = [1, 2].map((n) => addRun(store, { parent: golden, startedAt: T0 + 100 + n, calls: 'r', meta: { repeat: { group: 'g', attempt: n, of: 2 } } }));
    expect(team()).toEqual({ store: 'northwind-agent-runs/support-agent', state: 'only-here', localAttempts: { run: false, attempts: 2 } });
    // Pushed: nothing is only here any more.
    for (const id of attempts) store.setTeamRun(url, { runId: id, state: 'pushed', at: T0, base: null, baseHash: null, remoteHash: 'h2', entry: null });
    expect(team()).toEqual({ store: 'northwind-agent-runs/support-agent', state: 'in-store' });
  });
});
