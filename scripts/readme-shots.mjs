#!/usr/bin/env node
// The README's dashboard pictures, taken from the real dashboard on the demo project that
// scripts/demo-store.mjs builds (Northwind's support agents, every run made by the CLI against the
// mock providers in testing/):
//
//   dashboard-fork.png   the ticket agent's refund run forked at #17 by --override (what if
//                        lookup_policy had returned the EU limit?), with the request that changed
//   dashboard-fix.png    the refund fix: the call blame found the runs were lost at, the prompt
//                        repair proposed, and verify's verdict on every failing and good run
//
//   npm run build && node scripts/readme-shots.mjs [<demo folder>]
//
// Without a folder it builds the demo project in a temporary one first (about a minute) and removes
// it afterwards; with one, it uses what scripts/demo-store.mjs built there. It starts `shadowlap
// dashboard` in the project, as anyone would, and takes each picture with headless Chrome at twice
// the pixels, into .github/assets/readme/ (CHROME=/path/to/chrome chooses the browser): the page
// beside the sidebar and above the status bar of a 1280 by 800 window, in the README terminal's
// frame (rounded corners, transparent outside them, and a hairline edge). The dashboard runs with
// the demo folder as its home folder, so the paths it shows are the ones a project in your home
// folder shows (~/support-agent), never this machine's. It shows the dashboard as it is before
// anyone sets up a team store: the demo project names one, so `store` is taken out of the project's
// shadowlap.config.json while the dashboard runs, and the file is put back as it was afterwards. The
// dashboard is dark only. Run ids, commits, dates, times and durations differ from build to build;
// the rest comes out the same.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'packages', 'cli', 'bin', 'shadowlap.js');
const outDir = join(root, '.github', 'assets', 'readme');
/** Each picture's largest size: the README's pictures stay light. */
const MAX_BYTES = 450 * 1024;

const chrome = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
if (!chrome) {
  console.error('readme-shots: no Chrome found; set CHROME=/path/to/chrome');
  process.exit(1);
}
if (!existsSync(join(root, 'packages', 'dashboard', 'dist', 'ui', 'index.html'))) {
  console.error('readme-shots: the dashboard is not built; run npm run build first');
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const given = process.argv[2];
const scratch = mkdtempSync(join(tmpdir(), 'shadowlap-shots-'));
const children = [];
/** Puts the project's config back as it was, once the dashboard has stopped. */
let restoreConfig = null;

/** Runs a child to its end; its output is shown only when it fails. */
function run(command, args, options) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done(out) : fail(new Error(`${[command, ...args].join(' ')} exited with ${code}:\n${out}`))));
  });
}

try {
  // ---- the demo project ----
  let folder;
  if (given) {
    folder = realpathSync(resolve(given));
    if (!existsSync(join(folder, 'runs.json'))) throw new Error(`readme-shots: ${folder} holds no demo project (no runs.json); build one with scripts/demo-store.mjs`);
  } else {
    folder = join(realpathSync(scratch), 'demo');
    console.log('building the demo project (about a minute)…');
    await run(process.execPath, [join(root, 'scripts', 'demo-store.mjs'), folder], { cwd: root });
  }
  const { runs } = JSON.parse(readFileSync(join(folder, 'runs.json'), 'utf8'));
  for (const key of ['override', 'refundFix']) if (!runs[key]) throw new Error(`readme-shots: the demo project has no ${key} (runs.json); build it again without --fast`);

  // ---- no team store: the dashboard as a first-time user sees it ----
  // With `store` in the config, the pill beside the logo says team and the status bar names the
  // bucket and its last sync. Without it, they say dashboard and local only.
  const configFile = join(folder, 'support-agent', 'shadowlap.config.json');
  const configText = readFileSync(configFile, 'utf8');
  const config = JSON.parse(configText);
  delete config.store;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  restoreConfig = () => writeFileSync(configFile, configText);

  // ---- the dashboard, as `shadowlap dashboard` starts it in the project ----
  const LEAKS = /^(SHADOWLAP_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AWS_|AZURE_|LANGFUSE_|LANGSMITH_|OTEL_|GIT_|GITHUB_|GITLAB_|BITBUCKET_|BUILDKITE|CIRCLECI|JENKINS_URL|TF_BUILD|CI$|NODE_OPTIONS|PYTHONPATH|GH_)/;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !LEAKS.test(k))),
    HOME: folder,
    NO_COLOR: '1',
    SHADOWLAP_TELEMETRY: '0',
    SHADOWLAP_HOME: join(folder, 'home'),
    SHADOWLAP_PROJECT_ROOTS: folder,
    SHADOWLAP_AUTHOR: 'dana@example.com',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const port = 20000 + Math.floor(Math.random() * 10000);
  const dash = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '--port', String(port)], { cwd: join(folder, 'support-agent'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(dash);
  const link = await new Promise((done, fail) => {
    let out = '';
    const timer = setTimeout(() => fail(new Error(`readme-shots: the dashboard printed no link:\n${out}`)), 30_000);
    const look = (d) => {
      out += d;
      const m = /http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+/.exec(out);
      if (m) {
        clearTimeout(timer);
        done(m[0]);
      }
    };
    dash.stdout.on('data', look);
    dash.stderr.on('data', look);
    dash.on('close', () => fail(new Error(`readme-shots: the dashboard stopped:\n${out}`)));
  });

  // ---- Chrome over the DevTools protocol ----
  const devtools = 9400 + Math.floor(Math.random() * 400);
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--force-color-profile=srgb', `--remote-debugging-port=${devtools}`, `--user-data-dir=${join(scratch, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
  children.push(browser);
  let targets = [];
  for (let i = 0; i < 150 && !targets.length; i++) {
    try {
      targets = (await (await fetch(`http://127.0.0.1:${devtools}/json`)).json()).filter((t) => t.type === 'page');
    } catch {
      await wait(100);
    }
  }
  if (!targets.length) throw new Error('readme-shots: Chrome did not start');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  async function until(expression, what, ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await wait(100);
    }
    throw new Error(`readme-shots: timed out waiting for ${what}`);
  }
  await send('Page.enable');

  // ---- the pictures ----
  const origin = link.split('/#')[0];
  const token = /token=([\w-]+)/.exec(link)[1];
  const text = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;
  const shots = [
    {
      file: 'dashboard-fork.png',
      open: `/run/${runs.override}`,
      async ready() {
        await until(`!!document.querySelector('.banner.fork') && !!document.querySelector('.cells')`, 'the fork’s banner and calls');
        // The diff of the request that changed opens from the banner.
        await evaluate(`[...document.querySelectorAll('.banner.fork button')].find((b) => b.textContent.trim() === 'Show diff')?.click()`);
        await until(`!!document.querySelector('.diffpanel')`, 'the fork’s diff');
      },
    },
    {
      file: 'dashboard-fix.png',
      open: `/fixes/${runs.refundFix}`,
      async ready() {
        await until(`${text('Every failing run fixed')} && ${text('Lost at model call')}`, 'the fix’s verdict');
      },
    },
  ];
  mkdirSync(outDir, { recursive: true });
  // A desktop window: narrower, the dashboard stacks what sits side by side here. The picture is the
  // part beside the sidebar, above the status bar, so the README's column shows its text at four
  // fifths of its size, where the whole window would shrink it to two thirds.
  const W = 1280;
  const H = 800;
  for (const shot of shots) {
    await send('Emulation.setDefaultBackgroundColorOverride', {});
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Page.navigate', { url: `${origin}/#token=${token}&open=${shot.open}` });
    await shot.ready();
    await evaluate('document.fonts.ready.then(() => true)');
    await wait(700);
    const clip = await evaluate(`(() => {
      const side = document.querySelector('aside.side').getBoundingClientRect();
      const status = document.querySelector('footer.status').getBoundingClientRect();
      return { x: Math.ceil(side.right), y: 0, width: ${W} - Math.ceil(side.right), height: Math.floor(status.top) };
    })()`);
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
    const png = await framed(data, clip);
    const file = join(outDir, shot.file);
    writeFileSync(file, png);
    const bytes = statSync(file).size;
    console.log(`wrote ${relative(root, file)}: ${clip.width * 2}×${clip.height * 2}, ${(bytes / 1024).toFixed(0)} KB`);
    if (bytes > MAX_BYTES) throw new Error(`readme-shots: ${shot.file} is ${(bytes / 1024).toFixed(0)} KB, over the ${MAX_BYTES / 1024} KB a README picture may weigh`);
  }

  /**
   * The picture in the terminal picture's frame: corners rounded to the radius that one shows at the
   * README's width, transparent outside them, and a hairline edge in its colour, so the pictures
   * match on a light page and a dark one.
   */
  async function framed(data, { width, height }) {
    const radius = Math.round(width / 80);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await send('Page.navigate', { url: 'about:blank' });
    await until(`document.readyState === 'complete'`, 'a blank page');
    await evaluate(`(() => {
      document.documentElement.style.background = 'transparent';
      document.body.style.cssText = 'margin:0;background:transparent';
      document.body.innerHTML = '<div style="position:relative;width:${width}px;height:${height}px;border-radius:${radius}px;overflow:hidden"><img style="display:block;width:${width}px;height:${height}px"><div style="position:absolute;inset:0;border:1px solid #25261d;border-radius:${radius}px"></div></div>';
      const img = document.querySelector('img');
      img.src = 'data:image/png;base64,${data}';
      return img.decode().then(() => true);
    })()`);
    const { data: out } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } });
    return Buffer.from(out, 'base64');
  }
  ws.close();
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const gone = new Promise((r) => child.once('close', r));
    child.kill('SIGTERM');
    await Promise.race([gone, wait(10_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  restoreConfig?.();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
