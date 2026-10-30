// docs/dashboard.md keeps tables of the dashboard server's endpoints, an area each, and of its job kinds,
// for contributors. Each feature registers its own (packages/dashboard/src/routes/), so one can land
// without a row and nobody notices: injection, the error-path presets and coverage did. These checks
// read the routes from the sources and the job kinds from a running dashboard, and fail on any the
// tables leave out.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDashboard, type Dashboard } from '@shadowlap/dashboard';
import { Store } from '@shadowlap/engine';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ROUTES = join(ROOT, 'packages', 'dashboard', 'src', 'routes');

/** The rows of every endpoint table and of the job kinds table, each from its header to the first line that is no row. */
const rows = (() => {
  const lines = readFileSync(join(ROOT, 'docs', 'dashboard.md'), 'utf8').split('\n');
  const out: string[] = [];
  lines.forEach((line, at) => {
    if (!/^\|\s*(Endpoint|Job)\s*\|/.test(line)) return;
    for (let i = at + 2; i < lines.length && lines[i].startsWith('|'); i++) out.push(lines[i]);
  });
  return out;
})();

/** Every route the feature modules register, as `GET /injection/:id`. */
const routes = readdirSync(ROUTES)
  .filter((f) => f.endsWith('.ts'))
  .flatMap((f) => [...readFileSync(join(ROUTES, f), 'utf8').matchAll(/\brouter\.(get|post|put|delete)\(\s*'([^']+)'/g)].map((m) => ({ method: m[1].toUpperCase(), pattern: m[2], file: f })));

/**
 * Whether the table names a route: whole (`/api/injection/:id`), or as the table shortens a family of
 * them, its last segments after a path the same row names (`/api/runs/:id[?after=<n>]`, `/calls/:n`).
 * A parameter is written as one (`:id`, under any name) or as the values it takes (`normalize\|redact`).
 */
function named(pattern: string): boolean {
  const segments = pattern.split('/').filter(Boolean);
  const path = (from: number, to: number) => segments.slice(from, to).map((s) => (s.startsWith(':') ? '(?::\\w+|[\\w-]+(?:\\\\\\|[\\w-]+)+)' : escape(s))).join('/');
  const end = '(?=$|[\\s?\\[{])';
  const codes = (row: string) => row.split('`').filter((_, i) => i % 2 === 1);
  const whole = new RegExp(`(^|\\s)/api/${path(0, segments.length)}${end}`);
  return rows.some((row) => {
    if (codes(row).some((code) => whole.test(code))) return true;
    for (let i = 1; i < segments.length; i++) {
      const head = new RegExp(`/api/${path(0, i)}(?![\\w-])`);
      const tail = new RegExp(`^/${path(i, segments.length)}${end}`);
      if (head.test(row) && codes(row).some((code) => tail.test(code))) return true;
    }
    return false;
  });
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let project = '';
let store: Store;
let dash: Dashboard;

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), 'sl-dashboard-endpoints-'));
  store = Store.open(':memory:');
  dash = await startDashboard({ store, project: { path: project } });
});

afterAll(async () => {
  await dash?.close();
  store?.close();
  if (project) rmSync(project, { recursive: true, force: true });
});

describe("docs/dashboard.md's endpoint tables", () => {
  it('names every route the server registers', () => {
    expect(rows.length).toBeGreaterThan(20);
    expect(routes.length).toBeGreaterThan(50);
    const missing = routes.filter((r) => !named(r.pattern)).map((r) => `${r.method} /api${r.pattern} (routes/${r.file})`);
    expect(missing, 'routes the tables leave out').toEqual([]);
  });

  it('names every job kind the server registers', async () => {
    const meta = (await (await fetch(`${dash.url}/api/meta`, { headers: { 'x-shadowlap-token': dash.token } })).json()) as { jobKinds: string[] };
    expect(meta.jobKinds).toContain('injection');
    const table = rows.join('\n');
    const missing = meta.jobKinds.filter((k) => !table.includes(`\`${k}\``) && !table.includes(`\`${k} {`) && !table.includes(`"${k}"`));
    expect(missing, 'job kinds the tables leave out').toEqual([]);
  });

  it('notices a route it leaves out', () => {
    expect(named('/injection/:id/report')).toBe(true);
    expect(named('/runs/:id/calls/:n')).toBe(true);
    expect(named('/settings/redaction/preview')).toBe(true);
    expect(named('/settings/rules/:list')).toBe(true);
    expect(named('/injection/:id/nowhere')).toBe(false);
    expect(named('/runs/:id/nowhere')).toBe(false);
  });
});
