#!/usr/bin/env node
// Renders site/brand/dashboard-light.png and dashboard-dark.png: the dashboard on a real fork of the
// reference agent (recorded against the scripted mock API, so no key), captured with headless Chrome.
// Usage: node scripts/readme-shots.mjs   (after `npm run build`; CHROME=/path/to/chrome to choose a browser)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages', 'cli', 'bin', 'shadowlap.js');

const chrome = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
if (!chrome) {
  console.error('readme-shots: no Chrome found; set CHROME=/path/to/chrome');
  process.exit(1);
}

// A neutral working directory and command, so the pictures show `node agent.js`, not a local path.
const work = mkdtempSync(join(tmpdir(), 'shadowlap-demo-'));
writeFileSync(join(work, 'agent.js'), `import ${JSON.stringify(pathToFileURL(join(root, 'testing', 'reference-agent', 'dist', 'main.js')).href)};\n`);

const mock = spawn(process.execPath, [join(root, 'testing', 'reference-agent', 'dist', 'mock-server.js')], { stdio: ['ignore', 'pipe', 'ignore'] });
const mockUrl = await new Promise((ok, fail) => {
  let buf = '';
  mock.stdout.on('data', (c) => {
    buf += c;
    const m = /http:\/\/[^\s]+/.exec(buf);
    if (m) ok(m[0]);
  });
  mock.on('exit', () => fail(new Error('mock server exited')));
});
const env = { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mockUrl, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', AGENT_DATE: '2026-09-16' };
const fp = (...args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: work, env, encoding: 'utf8' });
  if (r.status !== 0 && args[0] !== 'replay') throw new Error(`shadowlap ${args.join(' ')} failed:\n${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
};
fp('run', '--', 'node', 'agent.js');
const recording = /Recorded (\S+):/.exec(fp('ls'))?.[1] ?? fp('ls').split(/\s+/)[0];
fp('replay', recording);
fp('replay', recording, '--inject', '17=Prefer sources from 2026.');
mock.kill();

const { Store } = await import(pathToFileURL(join(root, 'packages', 'engine', 'dist', 'index.js')).href);
const { startDashboard } = await import(pathToFileURL(join(root, 'packages', 'dashboard', 'dist', 'index.js')).href);
const dbPath = join(work, '.shadowlap', 'shadowlap.db');
const store = Store.open(dbPath);
const fork = store.allRuns().find((r) => r.divergence?.callNo === 17);
if (!fork) throw new Error('the fork at call 17 was not recorded');
const version = JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8')).version;
// Actions enabled, as `shadowlap dashboard` starts it; nothing is run while the pictures are taken.
const spawnCli = (args) => spawn(process.execPath, [cli, '--db', dbPath, ...args], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
const dash = await startDashboard({ store, dbPath, version, spawnCli });

// Chrome must run asynchronously: the dashboard serving it lives on this event loop.
const shot = (scheme, out) =>
  new Promise((ok, fail) => {
    const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--blink-settings=preferredColorScheme=${scheme === 'dark' ? 0 : 1}`, '--force-device-scale-factor=2', '--window-size=1440,900', '--virtual-time-budget=8000', `--screenshot=${out}`, dash.runUrl(fork.runId, 17)];
    const child = spawn(chrome, args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('exit', () => {
      clearTimeout(timer);
      if (!existsSync(out)) return fail(new Error(`Chrome wrote no screenshot to ${out}`));
      console.log(`wrote ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
      ok();
    });
  });
await shot('light', join(root, 'site', 'brand', 'dashboard-light.png'));
await shot('dark', join(root, 'site', 'brand', 'dashboard-dark.png'));

await dash.close();
store.close();
rmSync(work, { recursive: true, force: true });
