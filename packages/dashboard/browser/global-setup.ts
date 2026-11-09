import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDashboard } from './dashboard.js';

/**
 * Builds the demo store whole, as `npm run demo` does (or takes the one SHADOWLAP_DEMO_DIR names),
 * starts `shadowlap dashboard` on it as a user would, and hands the tests its address and session
 * token, with the ids of the runs and fixes the demo made (`runs.json`), through the file
 * SHADOWLAP_BROWSER_STATE names. The whole demo, not `--fast`: its fix has two verdicts to switch
 * between, its runs every kind of note and view, and the axe sweep goes through every one of them.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface BrowserState {
  origin: string;
  token: string;
  demo: string;
  runs: Record<string, string | string[]>;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(root, 'packages', 'dashboard', 'dist', 'ui', 'assets', 'app.js'))) throw new Error('build the dashboard first: npm run build');
  const given = process.env.SHADOWLAP_DEMO_DIR;
  const reuse = !!given && existsSync(join(given, 'runs.json'));
  const demo = reuse ? given : mkdtempSync(join(tmpdir(), 'shadowlap-browser-demo-'));
  if (!reuse) execFileSync(process.execPath, [join(root, 'scripts', 'demo-store.mjs'), demo], { stdio: ['ignore', 'ignore', 'inherit'] });

  const served = await serveDashboard(demo, 'support-agent');
  const state: BrowserState = { origin: served.origin, token: served.token, demo, runs: (JSON.parse(readFileSync(join(demo, 'runs.json'), 'utf8')) as { runs: BrowserState['runs'] }).runs };
  const file = join(mkdtempSync(join(tmpdir(), 'shadowlap-browser-state-')), 'state.json');
  writeFileSync(file, JSON.stringify(state));
  process.env.SHADOWLAP_BROWSER_STATE = file;

  return async () => {
    await served.stop();
    rmSync(dirname(file), { recursive: true, force: true });
    if (!reuse) rmSync(demo, { recursive: true, force: true });
  };
}
