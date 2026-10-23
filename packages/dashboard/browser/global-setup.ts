import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the demo store (or takes the one SHADOWLAP_DEMO_DIR names), starts `shadowlap dashboard` on
 * it as a user would, and hands the tests its address and session token, with the ids of the runs
 * and fixes the demo made (`runs.json`), through the file SHADOWLAP_BROWSER_STATE names.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = join(root, 'packages', 'cli', 'bin', 'shadowlap.js');

export interface BrowserState {
  origin: string;
  token: string;
  demo: string;
  runs: Record<string, string | string[]>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(root, 'packages', 'dashboard', 'dist', 'ui', 'assets', 'app.js'))) throw new Error('build the dashboard first: npm run build');
  const given = process.env.SHADOWLAP_DEMO_DIR;
  const reuse = !!given && existsSync(join(given, 'runs.json'));
  const demo = reuse ? given! : mkdtempSync(join(tmpdir(), 'shadowlap-browser-demo-'));
  if (!reuse) execFileSync(process.execPath, [join(root, 'scripts', 'demo-store.mjs'), demo, '--fast'], { stdio: ['ignore', 'ignore', 'inherit'] });

  const port = await freePort();
  const env = { ...process.env, SHADOWLAP_HOME: join(demo, 'home'), SHADOWLAP_PROJECT_ROOTS: demo, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0' };
  const child = spawn(process.execPath, [cli, 'dashboard', '--no-open', '--port', String(port)], { cwd: join(demo, 'support-agent'), env, stdio: ['ignore', 'ignore', 'pipe'] });
  const link = await new Promise<string>((resolve, reject) => {
    let said = '';
    const timer = setTimeout(() => reject(new Error(`the dashboard printed no link in 30 s:\n${said}`)), 30_000);
    child.stderr!.on('data', (chunk: Buffer) => {
      said += chunk.toString('utf8');
      const m = /(http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+)/.exec(said);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the dashboard exited (${code}) before printing its link:\n${said}`));
    });
  });
  const url = new URL(link);
  const state: BrowserState = { origin: url.origin, token: /token=([\w-]+)/.exec(url.hash)![1]!, demo, runs: (JSON.parse(readFileSync(join(demo, 'runs.json'), 'utf8')) as { runs: BrowserState['runs'] }).runs };
  const file = join(mkdtempSync(join(tmpdir(), 'shadowlap-browser-state-')), 'state.json');
  writeFileSync(file, JSON.stringify(state));
  process.env.SHADOWLAP_BROWSER_STATE = file;

  return async () => {
    const ended = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    rmSync(dirname(file), { recursive: true, force: true });
    if (!reuse) rmSync(demo, { recursive: true, force: true });
  };
}
