// A screen recording of the dashboard, generated: records the reference agent against the scripted
// API (no key), then drives the dashboard in headless Chrome with a visible cursor, from a call's
// conversation to a streamed response, a fork with an injected instruction, the fork's diff, its
// context, timeline and family views, and the comparison, and encodes the frames with ffmpeg.
//
//   npm run build && node scripts/dashboard-video.mjs [--dark]
//   writes scripts/out/dashboard-tour.mp4 and scripts/out/dashboard-tour.jpg (the poster); the
//   dashboard is dark only, so --dark only names the files dashboard-tour-dark.*
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages', 'cli', 'bin', 'shadowlap.js');
const dark = process.argv.includes('--dark');
const W = 1440;
const H = 900;
const chrome = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
if (!chrome) throw new Error('no Chrome found; set CHROME=/path/to/chrome');
if (spawnSync('ffmpeg', ['-version']).status !== 0) throw new Error('ffmpeg is needed to encode the video');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), 'shadowlap-video-'));
writeFileSync(join(work, 'agent.js'), `import ${JSON.stringify(pathToFileURL(join(root, 'testing', 'reference-agent', 'dist', 'main.js')).href)};\n`);

// ---- A recording and a clean replay; the fork happens on camera.
// Two fake APIs: a paced one for the recording, so its streams are worth playing back, and a quick
// one for the fork made on camera, so the CLI's output does not keep the viewer waiting.
function startMock(delayMs) {
  const child = spawn(process.execPath, [join(root, 'testing', 'reference-agent', 'dist', 'mock-server.js')], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, MOCK_EVENT_DELAY_MS: String(delayMs) } });
  const url = new Promise((ok, fail) => {
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c;
      const m = /http:\/\/[^\s]+/.exec(buf);
      if (m) ok(m[0]);
    });
    child.on('exit', () => fail(new Error('mock server exited')));
  });
  return { child, url };
}
const paced = startMock(90);
const quick = startMock(0);
const [pacedUrl, mockUrl] = await Promise.all([paced.url, quick.url]);
const env = { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mockUrl, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', AGENT_DATE: '2026-09-16', SHADOWLAP_GUARD: 'off' };
const fp = (...args) => {
  const extra = typeof args.at(-1) === 'object' ? args.pop() : {};
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
};
const recordingId = /recording run (\w{26})/.exec(fp('run', '--', 'node', 'agent.js', { SHADOWLAP_UPSTREAM_ANTHROPIC: pacedUrl }))?.[1];
if (!recordingId) throw new Error('the recording failed');
fp('replay', recordingId);

const { Store } = await import(pathToFileURL(join(root, 'packages', 'engine', 'dist', 'index.js')).href);
const { startDashboard } = await import(pathToFileURL(join(root, 'packages', 'dashboard', 'dist', 'index.js')).href);
const dbPath = join(work, '.shadowlap', 'shadowlap.db');
const store = Store.open(dbPath);
const version = JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8')).version;
const spawnCli = (args) => spawn(process.execPath, [cli, '--db', dbPath, ...args], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
const dash = await startDashboard({ store, dbPath, version, spawnCli });

// ---- Chrome over the DevTools protocol.
const port = 9400 + Math.floor(Math.random() * 400);
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${join(work, 'chrome')}`, `--window-size=${W},${H}`, `--blink-settings=preferredColorScheme=${dark ? 0 : 1}`, 'about:blank'], { stdio: 'ignore' });
let targets = [];
for (let i = 0; i < 100 && !targets.length; i++) {
  try {
    targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page');
  } catch {
    await wait(100);
  }
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const listeners = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  } else if (m.method) listeners.get(m.method)?.(m.params);
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
await send('Page.enable');
await send('Page.navigate', { url: dash.runUrl(recordingId, 3) });
for (let i = 0; i < 100; i++) {
  if (await evaluate(`document.querySelectorAll('table.calls tbody tr').length > 0`)) break;
  await wait(100);
}
await wait(800);

// A cursor, since headless Chrome draws none.
const CURSOR = `(() => {
  const c = document.createElement('div');
  c.id = 'tour-cursor';
  c.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 20 L7 15.5 L10.5 23.5 L13.5 22.2 L10 14.3 L17 14.3 Z" fill="#f4f4f0" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '99999', pointerEvents: 'none', transform: 'translate(${W * 0.6}px, ${H * 0.55}px)', transition: 'transform 700ms cubic-bezier(.3,.7,.2,1)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))' });
  document.body.appendChild(c);
})()`;
await evaluate(CURSOR);
let cursor = { x: W * 0.6, y: H * 0.55 };

// ---- Frames: the screencast emits one whenever the page paints.
const frames = [];
const framesDir = join(work, 'frames');
mkdirSync(framesDir);
listeners.set('Page.screencastFrame', (p) => {
  const file = join(framesDir, `${String(frames.length).padStart(5, '0')}.jpg`);
  writeFileSync(file, Buffer.from(p.data, 'base64'));
  frames.push({ file, t: p.metadata.timestamp });
  void send('Page.screencastFrameAck', { sessionId: p.sessionId });
});
await send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
// Keep frames flowing while nothing moves, so holds have their real length.
await evaluate(`(() => { const tick = document.createElement('div'); Object.assign(tick.style, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', opacity: '0.01' }); document.body.appendChild(tick); let n = 0; setInterval(() => { tick.style.opacity = (n++ % 2) ? '0.01' : '0.02'; }, 40); })()`);

async function centerOf(selectorJs) {
  const box = await evaluate(`(() => { const el = ${selectorJs}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`not on the page: ${selectorJs}`);
  return box;
}
async function moveTo(selectorJs, ms = 700) {
  const { x, y } = await centerOf(selectorJs);
  await evaluate(`(() => { const c = document.getElementById('tour-cursor'); c.style.transitionDuration = '${ms}ms'; c.style.transform = 'translate(${x - 3}px, ${y - 2}px)'; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  cursor = { x, y };
  await wait(ms + 120);
}
async function click(selectorJs, ms) {
  await moveTo(selectorJs, ms);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cursor.x, y: cursor.y, button: 'left', clickCount: 1 });
  await evaluate(`document.getElementById('tour-cursor').animate([{ scale: 1 }, { scale: .82 }, { scale: 1 }], { duration: 220 })`);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cursor.x, y: cursor.y, button: 'left', clickCount: 1 });
}
async function type(text, perChar = 38) {
  for (const ch of text) {
    await send('Input.insertText', { text: ch });
    await wait(perChar);
  }
}
async function until(expression, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(expression)) return true;
    await wait(100);
  }
  if (process.env.DEBUG_SHOT) writeFileSync(process.env.DEBUG_SHOT, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  throw new Error(`timed out waiting for ${expression}`);
}
const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().toLowerCase().startsWith(${JSON.stringify(text.toLowerCase())}))`;
const row = (n) => `[...document.querySelectorAll('table.calls tbody tr')].find((r) => r.querySelector('td')?.textContent.trim().endsWith('${n}'))`;

// ---- The walkthrough. Paced for a looping figure: no beat outstays what it shows.
await wait(900);
await moveTo(`document.querySelector('.cells')`, 700);
await wait(450);
await click(row(17));
await wait(1100);
await evaluate(`document.querySelector('.ibody').scrollTo({ top: 1e6, behavior: 'smooth' })`);
await wait(800);
await click(byText('.insp [role=tab]', 'Response'));
await wait(450);
await click(byText('.play button', 'Play'), 450);
await wait(2000);
await click(`document.getElementById('forkBtn')`);
await wait(600);
await click(byText('.pop.fkm button', 'Inject an instruction'), 500);
await until(`!!document.querySelector('textarea')`);
await wait(350);
await type('Prefer sources from 2026.', 26);
await wait(400);
await click(`document.querySelector('.dialog .dlg-ok')`, 500);
await until(`!!document.querySelector('.drawer a.btn.lime')`, 60_000);
// The command's output is a wall of small type; show that it ran, then move on.
await wait(1100);
// Opening the new run closes the drawer.
await click(`document.querySelector('.drawer a.btn.lime')`);
await until(`location.hash.includes('/run/') && !location.hash.includes('${recordingId}')`);
await wait(500);
if (await evaluate(`!!document.querySelector('.drawer')`)) await click(`document.querySelector('.drawer [aria-label=Close]')`, 600);
await wait(700);
await moveTo(`document.querySelector('.cells button.mark') ?? document.querySelector('.cells')`, 700);
await wait(600);
// A fork opens with its diff shown; open it if this build starts it closed.
if (await evaluate(`!!${byText('button', 'Show diff')}`)) await click(byText('button', 'Show diff'));
await moveTo(`document.querySelector('.diffpanel') ?? document.querySelector('.banner')`, 700);
await wait(1800);
// The fork from other angles: its context and cache per model call, its calls on a clock, its family.
const view = (name) => `[...document.querySelectorAll('.views [role=tab]')].find((b) => b.textContent.trim().startsWith('${name}'))`;
await click(view('Context'), 600);
await wait(450);
await moveTo(`[...document.querySelectorAll('.cbar')].at(-4)`, 600);
await wait(1200);
await click(view('Timeline'), 550);
await wait(1400);
await click(view('Forks'), 550);
await wait(1500);
await click(byText('a.btn', 'Compare'));
await wait(2600);
await send('Page.stopScreencast');
await wait(300);

// ---- Encode: each frame lasts until the next one; the last is held.
if (frames.length < 20) throw new Error(`only ${frames.length} frames were captured`);
const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? f.t + 2) - f.t).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
writeFileSync(join(work, 'frames.txt'), list);
mkdirSync(join(root, 'scripts', 'out'), { recursive: true });
const out = join(root, 'scripts', 'out', `dashboard-tour${dark ? '-dark' : ''}.mp4`);
const enc = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(work, 'frames.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', out], { encoding: 'utf8' });
if (enc.status !== 0) throw new Error(enc.stderr);
const poster = out.replace(/\.mp4$/, '.jpg');
spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-sseof', '-1', '-i', out, '-frames:v', '1', '-q:v', '3', poster]);
const seconds = frames.at(-1).t - frames[0].t + 2;
console.log(`wrote ${out}: ${seconds.toFixed(1)} s, ${frames.length} frames, ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB; poster ${poster}`);

ws.close();
await new Promise((r) => {
  browser.once('exit', r);
  browser.kill();
});
paced.child.kill();
quick.child.kill();
await dash.close();
store.close();
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
