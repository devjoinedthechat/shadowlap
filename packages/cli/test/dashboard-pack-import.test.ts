import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type Dashboard, type JobView } from '@shadowlap/dashboard';
import { packArchive, pickedPack } from '../../dashboard/ui/runspage/pack-folder.js';
import { folderFiles, writePack } from '../../dashboard/test/pack-fixture.js';

/**
 * Import capture… → Pack, end to end through the real CLI: a pack's folder, sent as the archive the
 * dialog writes, is unpacked by the dashboard's server into its upload's own folder and imported by
 * `shadowlap unpack`, whose runs then say they came from the folder picked. The upload and that
 * folder go when the job ends.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

let project: string;
let store: Store;
let dash: Dashboard | null = null;
let packs: string;
const telemetry = process.env.SHADOWLAP_TELEMETRY;

beforeEach(async () => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-pack-import-')));
  packs = mkdtempSync(join(tmpdir(), 'sl-pack-import-sent-'));
  process.env.SHADOWLAP_TELEMETRY = '0';
  store = Store.open(join(project, 'store.db'));
  dash = await startDashboard({ store, project: { path: project }, spawnCli: cliSpawner({ command: [process.execPath, CLI], dbPath: join(project, 'store.db'), cwd: project }) });
});
afterEach(async () => {
  await dash?.close();
  dash = null;
  store.close();
  rmSync(project, { recursive: true, force: true });
  rmSync(packs, { recursive: true, force: true });
  if (telemetry === undefined) delete process.env.SHADOWLAP_TELEMETRY;
  else process.env.SHADOWLAP_TELEMETRY = telemetry;
});

const api = (path: string, init: { method?: string; body?: string | Buffer; headers?: Record<string, string> } = {}) =>
  fetch(`${dash!.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash!.token, origin: dash!.url, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...init.headers } });

/** The pack's folder as the dialog sends it: its archive, named for the folder. */
async function send(dir: string, name: string): Promise<string> {
  const archive = packArchive(pickedPack(folderFiles(dir), null).files);
  const res = await api('uploads', { method: 'POST', body: Buffer.from(await archive.arrayBuffer()), headers: { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' } });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { uploadId: string }).uploadId;
}

async function finished(j: JobView): Promise<JobView & { result?: unknown }> {
  for (let i = 0; i < 600; i++) {
    const view = (await (await api(`jobs/${j.id}`)).json()) as JobView & { result?: unknown };
    if (view.done) return view;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${j.id} did not end`);
}

describe('Import capture… → Pack', () => {
  it('imports a pack’s folder through shadowlap unpack, its runs from the folder picked, and leaves no upload behind', async () => {
    // A folder's name as people give one, its space and brackets kept: one argument, and the runs' source.
    const { dir, runIds } = writePack('support refund (2)', packs);
    const uploadId = await send(dir, 'support refund (2).tar');
    const res = await api('jobs', { method: 'POST', body: JSON.stringify({ kind: 'import', format: 'pack', uploadId }) });
    expect(res.status, await res.clone().text()).toBe(202);
    const job = await finished((await res.json()) as JobView);
    expect(job, job.lines.join('\n')).toMatchObject({ code: 0, title: 'Importing pack', args: ['unpack', `.shadowlap/uploads/${uploadId}/support refund (2)`], newRunId: runIds[1] });
    expect(job.result).toEqual({ imported: runIds, skipped: [], mismatched: [] });
    expect(job.links).toEqual(runIds.map((id) => ({ label: `Open ${id.slice(0, 10)}`, href: `#/run/${id}` })));
    for (const id of runIds) expect(store.getRun(id)!.meta?.imported?.from).toBe('support refund (2)');
    // The upload and the folder it was unpacked into go with the job.
    for (let i = 0; i < 100 && existsSync(join(project, '.shadowlap', 'uploads', uploadId)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(join(project, '.shadowlap', 'uploads'))).toEqual([]);

    // Sent again, it brings nothing: the store holds both runs already.
    const again = await api('jobs', { method: 'POST', body: JSON.stringify({ kind: 'import', format: 'pack', uploadId: await send(dir, 'support refund (2).tar') }) });
    expect((await finished((await again.json()) as JobView)).result).toEqual({ imported: [], skipped: runIds, mismatched: [] });
  }, 60_000);

  it('ends on unpack’s refusal of a run.json of another format, the folder named as it was picked', async () => {
    const { dir } = writePack('support-refund', packs);
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')), format: 'some-other-pack' }));
    const uploadId = await send(dir, 'support-refund.tar');
    const res = await api('jobs', { method: 'POST', body: JSON.stringify({ kind: 'import', format: 'pack', uploadId }) });
    const job = await finished((await res.json()) as JobView);
    expect(job.code).toBe(2);
    expect(job.lines).toContain(`shadowlap: .shadowlap/uploads/${uploadId}/support-refund: unexpected format some-other-pack`);
    expect(store.allRuns()).toEqual([]);
  }, 60_000);
});
