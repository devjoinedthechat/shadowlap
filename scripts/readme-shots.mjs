#!/usr/bin/env node
// The README's story, run with the real CLI, and the dashboard pictures taken from the project it
// leaves. The agents are the demo's support agents (scripts/demo-store/project/) and the models its
// scripted ones (scripts/demo-store/models.mjs), on the mock Anthropic API in testing/: no key is
// needed and nothing leaves this machine.
//
// One order, start to finish: the support agent refunds order A-1042 for $240, though its policy
// sends refunds above $100 to a manager. Four runs are recorded, three of them refunds (labelled
// refund-bug) and one good run; blame finds the model call that lost the first, repair finds the
// fix and verifies it, and fix apply applies it and tests the goldens it brings, which are then
// committed with it. The ticket agent handles the same order from a ticket: decisions asks its
// model calls again under claude-haiku-4-5, and a replay overrides what lookup_policy returned
// (what if it had returned the EU limit?), so the run forks at #17.
//
//   npm run build && node scripts/readme-shots.mjs [<folder>]
//
// It writes into .github/assets/readme/:
//
//   dashboard-fork.png         the override fork: its strip of calls, the calls from the fork on, and
//                              the diff of the request that changed, at its change
//   dashboard-fix.png          the fix: the call blame found, the prompt repair proposed, and verify's
//                              verdict on every failing and good run
//   dashboard-fork-medium.png  the same pages 640 px wide, in the dashboard's narrow layout, for the
//   dashboard-fix-medium.png   README's column on a tablet or in a narrow window: the fix down to
//                              verify's verdict
//   dashboard-fork-phone.png   the same pages in the dashboard's phone layout: the fork down to its
//   dashboard-fix-phone.png    strip of calls, the fix down to verify's verdict
//
// and what each command of the story printed into <folder>/samples/, where the README's console
// examples come from: blame, repair, fix apply, decisions and the override. Without a folder the
// story runs in a temporary one, removed afterwards, and the samples are printed here. Given a
// folder an earlier run left, it takes the pictures again without running the story; in its
// support-agent/, `shadowlap ui <fork>` shows the fork in the terminal UI.
//
// The dashboard runs as `shadowlap dashboard` starts it in the project, with the folder as its home
// folder, so the paths it shows are the ones a project in your home folder shows (~/support-agent),
// never this machine's; and as a first-time user sees it, with no team store set up: a `store` in
// the project's shadowlap.config.json is taken out while it runs, and the file put back as it was.
// Each picture is taken at twice the pixels by Chromium's headless shell as Playwright installs it
// (npx playwright install chromium-headless-shell, in packages/dashboard), or by the Chrome that
// CHROME=/path/to/chrome names: on a desktop, the page beside the sidebar and under the top bar of a
// 1280 by 800 window; in a medium window, the page 640 px wide, top bar included; on a phone, the
// page 390 px wide, as a touch screen shows it. Each starts at the page's top and ends under a part
// of the page, never through one, or at the status bar. It is in the README terminal's frame (rounded corners,
// transparent outside them, and a hairline edge). The dashboard is dark only. Run ids, dates and
// durations differ from run to run; the rest comes out the same.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'packages', 'cli', 'bin', 'shadowlap.js');
const kit = join(root, 'scripts', 'demo-store');
const outDir = join(root, '.github', 'assets', 'readme');
/** Each picture's largest size: the README's pictures stay light. */
const MAX_BYTES = 450 * 1024;

if (process.env.CHROME && !existsSync(process.env.CHROME)) {
  console.error(`readme-shots: CHROME names ${process.env.CHROME}, which isn't there`);
  process.exit(1);
}
for (const built of ['packages/cli/dist/index.js', 'packages/dashboard/dist/ui/index.html', 'testing/mock-anthropic/dist/index.js']) {
  if (!existsSync(join(root, built))) {
    console.error(`readme-shots: ${built} is missing; run npm run build first`);
    process.exit(1);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const given = process.argv[2];
const scratch = mkdtempSync(join(tmpdir(), 'shadowlap-shots-'));
const children = [];
/** The browser that takes the pictures, once it has started. */
let browser = null;
/** Puts the project's config back as it was, once the dashboard has stopped. */
let restoreConfig = null;

/** A word as a shell would need it typed. */
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// Nothing of this machine's own setup reaches the story or the dashboard: no provider keys or
// endpoints, no cloud credentials, no CI markers, no git configuration.
const LEAKS = /^(SHADOWLAP_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AWS_|AZURE_|LANGFUSE_|LANGSMITH_|OTEL_|GIT_|GITHUB_|GITLAB_|BITBUCKET_|BUILDKITE|CIRCLECI|JENKINS_URL|TF_BUILD|CI$|NODE_OPTIONS|PYTHONPATH|GH_)/;
const envFor = (folder) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !LEAKS.test(k))),
  HOME: folder,
  NO_COLOR: '1',
  SHADOWLAP_TELEMETRY: '0',
  SHADOWLAP_HOME: join(folder, 'home'),
  SHADOWLAP_PROJECT_ROOTS: folder,
  SHADOWLAP_AUTHOR: 'dana@example.com',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
});

/** The story, in a new or empty folder: the project, its runs, and what each README command printed. */
async function story(folder) {
  const { startMockAnthropic } = await import('@shadowlap-testing/mock-anthropic');
  const { createModels } = await import(pathToFileURL(join(kit, 'models.mjs')).href);
  const models = createModels();
  const { control } = models;
  const anthropic = await startMockAnthropic({ script: models.anthropic, eventDelayMs: () => control.delay });
  const project = join(folder, 'support-agent');
  const samples = join(folder, 'samples');
  const env = {
    ...envFor(folder),
    SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url,
    // The repairer repair asks is the mock too; the agents' key is a placeholder.
    ANTHROPIC_BASE_URL: anthropic.url,
    ANTHROPIC_API_KEY: 'demo-key',
    GIT_AUTHOR_NAME: 'Dana',
    GIT_AUTHOR_EMAIL: 'dana@example.com',
    GIT_COMMITTER_NAME: 'Dana',
    GIT_COMMITTER_EMAIL: 'dana@example.com',
  };
  const git = (...args) => execFileSync('git', args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  /**
   * Runs the CLI in the project, its output and its errors into one file in the order it wrote them,
   * as a terminal shows them; returns what it printed. A sample's file is samples/<name>.txt, the
   * command first, as typed.
   */
  async function sl(args, sample = null) {
    const file = sample ? join(samples, `${sample}.txt`) : join(folder, '.build', 'last.txt');
    const fd = openSync(file, 'w');
    let code;
    try {
      code = await new Promise((done, fail) => {
        const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env, stdio: ['ignore', fd, fd] });
        child.on('error', fail);
        child.on('close', done);
      });
    } finally {
      closeSync(fd);
    }
    const out = readFileSync(file, 'utf8');
    if (code !== 0) throw new Error(`readme-shots: shadowlap ${args.join(' ')} exited with ${code}:\n${out}`);
    if (sample) writeFileSync(file, `$ shadowlap ${args.map(quote).join(' ')}\n${out}`);
    return out;
  }
  const runIn = (out) => /(?:recording|replaying) run (\w{26})/.exec(out)?.[1] ?? fail(`no run in:\n${out}`);
  const fixIn = (out) => /\bfix (fx-\w+)/.exec(out)?.[1] ?? fail(`no fix in:\n${out}`);
  const short = (id) => id.slice(0, 10);
  try {
    mkdirSync(samples, { recursive: true });
    mkdirSync(join(folder, '.build'), { recursive: true });
    cpSync(join(kit, 'project'), project, { recursive: true });
    // The agents import their SDKs as any project does; these come from this repository.
    symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(project, '.gitignore'), 'node_modules\n.shadowlap/\n');
    git('init', '-q', '-b', 'main');
    await sl(['init']);
    git('add', '-A');
    git('commit', '-q', '-m', 'Start the support agent');

    // The model refunds the $240 orders its policy says need a manager; the in-limit order is a good run.
    const runs = { refundBug: [] };
    control.refund = 'refund';
    for (const order of ['A-1042', 'A-1077', 'A-1103']) {
      const id = runIn(await sl(['run', '--', 'node', 'agent.mjs', order]));
      await sl(['label', short(id), 'refund-bug']);
      runs.refundBug.push(id);
    }
    runs.good = runIn(await sl(['run', '--', 'node', 'agent.mjs', 'A-1120']));
    await sl(['label', short(runs.good), 'good']);

    // Asked again at the decision, the model escalates every other time: the rescue blame looks for.
    control.refund = 'alternate';
    runs.refundFix = fixIn(await sl(['blame', short(runs.refundBug[0]), '--expect', '@refund-check.json'], 'blame'));
    await sl(['repair', '--fixes', 'label:refund-bug', '--keeps', 'label:good', '--expect', '@refund-check.json', '--repairer', 'anthropic'], 'repair');
    control.refund = 'refund';
    await sl(['fix', 'apply', runs.refundFix], 'fix-apply');
    git('add', '-A');
    git('commit', '-q', '-m', 'Escalate refunds above the policy limit');

    // The ticket agent, paced like a model that streams, so the recording plays back as it arrived.
    control.delay = 12;
    runs.ticket = runIn(await sl(['run', '--', 'node', 'refund_agent.mjs', 'T-8812']));
    control.delay = 0;
    await sl(['decisions', short(runs.ticket), '--model', 'claude-haiku-4-5'], 'decisions');
    runs.override = runIn(await sl(['replay', short(runs.ticket), '--override', '16=@policy.json'], 'override'));
    writeFileSync(join(folder, 'runs.json'), `${JSON.stringify({ story: 'readme', runs }, null, 2)}\n`);
    return runs;
  } finally {
    await anthropic.close();
  }
}

function fail(message) {
  throw new Error(`readme-shots: ${message}`);
}

try {
  // ---- the story ----
  let folder;
  let runs;
  if (given) {
    mkdirSync(resolve(given), { recursive: true });
    folder = realpathSync(resolve(given));
    if (existsSync(join(folder, 'runs.json'))) {
      ({ runs } = JSON.parse(readFileSync(join(folder, 'runs.json'), 'utf8')));
      if (!runs?.override || !runs?.refundFix) fail(`${folder} holds no story this script ran (runs.json names no fork and no fix)`);
    } else if (readdirSync(folder).length) fail(`${folder} isn't empty and holds no story; give a new folder`);
  } else folder = join(realpathSync(scratch), 'story');
  if (!runs) {
    console.log('running the story (under a minute)…');
    runs = await story(folder);
    const samples = join(folder, 'samples');
    if (given) console.log(`what each command printed: ${samples}\nthe fork in the terminal UI: cd ${join(folder, 'support-agent')} && shadowlap ui ${runs.override.slice(0, 10)}`);
    else for (const f of readdirSync(samples).sort()) console.log(`\n---- ${f}\n${readFileSync(join(samples, f), 'utf8')}`);
  }

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
  const env = envFor(folder);
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

  // ---- Chromium over the DevTools protocol, started by Playwright: by default its headless shell,
  // never the Chrome for Testing it installs beside it, which hangs here ----
  const { chromium } = await import('@playwright/test');
  try {
    browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb'] });
  } catch (err) {
    const why = String(err.message).split('\n')[0] ?? '';
    throw new Error(`readme-shots: no browser to take the pictures with (${why}): install Playwright's headless shell (npx playwright install chromium-headless-shell, in packages/dashboard), or set CHROME=/path/to/chrome`, { cause: err });
  }
  // No viewport of Playwright's: the pictures set their own sizes below.
  const page = await browser.newPage({ viewport: null });
  const cdp = await page.context().newCDPSession(page);
  const send = (method, params = {}) =>
    cdp.send(method, params).catch((/** @type {unknown} */ err) => {
      throw new Error(`${method}: ${err instanceof Error ? err.message : String(err)}`);
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
      name: 'dashboard-fork',
      open: `/run/${runs.override}`,
      async ready() {
        await until(`!!document.querySelector('.banner.fork') && !!document.querySelector('.cells')`, 'the fork’s banner and calls');
        // The diff of the request that changed opens from the banner.
        await evaluate(`[...document.querySelectorAll('.banner.fork button')].find((b) => b.textContent.trim() === 'Show diff')?.click()`);
        await until(`!!document.querySelector('.diffpanel .jl.del, .diffpanel .jl.add')`, 'the fork’s diff');
        // It opens at the top of the request; what changed is the lines further down, brought into view.
        await evaluate(`(document.querySelector('.diffpanel .jl.del, .diffpanel .jl.add').scrollIntoView({ block: 'center' }), true)`);
      },
      // On a desktop the whole page, the diff open beside the calls ('window': down to the status
      // bar). Narrower, where the diff goes under every call, down to the strip of the calls the fork
      // made and its key: the strip's box lays its parts out apart there, the cells kept at the top.
      end: { desktop: 'window', medium: '.strip .legend', phone: '.strip .legend' },
    },
    {
      name: 'dashboard-fix',
      open: `/fixes/${runs.refundFix}`,
      async ready() {
        await until(`${text('Every failing run fixed')} && ${text('Lost at model call')}`, 'the fix’s verdict');
      },
      // Down to verify's table of runs; narrower, where that table scrolls sideways, to its verdict.
      end: { desktop: '.verdict ~ section.panel.tscroll', medium: '.verdict', phone: '.verdict' },
    },
  ];
  mkdirSync(outDir, { recursive: true });
  // A desktop window: narrower, the dashboard stacks what sits side by side here. The picture is the
  // part beside the sidebar, so the README's column shows its text at four fifths of its size, where
  // the whole window would shrink it to two thirds. A medium window, 640 px wide, for the README's
  // column between a phone's and a wide screen's (400 to 660 px), where the desktop picture's text
  // would shrink to a third: the dashboard's narrow layout, top bar included. A phone: its phone
  // layout, as a touch screen shows it (no keyboard help). Each window is tall enough that the
  // picture ends above the status bar. The frame's corners are those of the README terminal shown
  // beside it: the wide one on a desktop, the medium one, and the narrow one on a phone.
  const sizes = [
    { size: 'desktop', suffix: '', width: 1280, height: 800, mobile: false, radius: (w) => w / 80 },
    { size: 'medium', suffix: '-medium', width: 640, height: 2000, mobile: false, radius: (w) => w / 53 },
    { size: 'phone', suffix: '-phone', width: 390, height: 2000, mobile: true, radius: (w) => w / 36 },
  ];
  for (const s of sizes) {
    for (const shot of shots) {
      const file = `${shot.name}${s.suffix}.png`;
      const end = shot.end[s.size];
      await send('Emulation.setDefaultBackgroundColorOverride', {});
      await send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: 2, mobile: s.mobile });
      await send('Emulation.setTouchEmulationEnabled', s.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      await send('Page.navigate', { url: `${origin}/#token=${String(token)}&open=${shot.open}` });
      await shot.ready();
      await evaluate('document.fonts.ready.then(() => true)');
      await wait(700);
      // A run's page opens at the call it is about, scrolled to it: the picture is the page from its
      // top. The page scrolls in its own box, or on a phone the window does.
      await evaluate(`(window.scrollTo(0, 0), document.querySelectorAll('#view .page').forEach((p) => (p.scrollTop = 0)), true)`);
      await wait(300);
      // The picture ends under a part of the page, never through one: 24 px under it, or just above
      // what follows it, whichever comes first. Where what follows starts closer than 16 px under it,
      // the frame adds the rest of 16 px in the page's own background, so the frame's edge never
      // touches the part (the fork's strip of calls, whose marker sits under its cells). A tint the
      // page shows through, such as the verdict's, is not that background: the first opaque one is.
      // 'window' is the whole page, down to the status bar.
      const clip = await evaluate(`(() => {
        const status = document.querySelector('footer.status').getBoundingClientRect().top;
        const whole = ${JSON.stringify(end)} === 'window';
        const part = whole ? document.querySelector('#view') : document.querySelector(${JSON.stringify(end)});
        if (!part) return null;
        let next = whole ? null : part.nextElementSibling;
        while (next && !next.getBoundingClientRect().height) next = next.nextElementSibling;
        const below = whole ? status : part.getBoundingClientRect().bottom;
        const bottom = whole ? Math.floor(status) : Math.floor(Math.min(below + 24, next ? next.getBoundingClientRect().top - 1 : Infinity));
        if (bottom > status) return { under: true };
        // The sidebar beside the page in a wide window; none in a narrow one, where it is a menu. In a
        // wide window the top bar runs over the sidebar too, its logo and crumbs above the sidebar's
        // column, so the page starts under it: a picture of the page beside the sidebar would cut the
        // crumbs at its edge.
        const wide = ${s.width} > 1000;
        const left = wide ? Math.ceil(document.querySelector('aside.side').getBoundingClientRect().right) : 0;
        const top = wide ? Math.ceil(document.querySelector('header.top').getBoundingClientRect().bottom) : 0;
        const alpha = (color) => {
          if (color === 'transparent') return 0;
          const a = /^rgba\\(.*,\\s*([\\d.]+)(%?)\\)$/.exec(color) || /\\/\\s*([\\d.]+)(%?)\\)$/.exec(color);
          return a ? parseFloat(a[1]) / (a[2] ? 100 : 1) : 1;
        };
        let behind = part;
        while (behind && alpha(getComputedStyle(behind).backgroundColor) < 1) behind = behind.parentElement;
        return { x: left, y: top, width: ${s.width} - left, height: bottom - top, pad: whole ? 0 : Math.max(0, Math.ceil(below + 16 - bottom)), background: behind ? getComputedStyle(behind).backgroundColor : 'transparent' };
      })()`);
      if (!clip) fail(`${file}: the page has no ${end}`);
      if (clip.under) fail(`${file}: ${end} ends under the status bar of a ${s.width} by ${s.height} window`);
      const { pad, background, ...area } = clip;
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...area, scale: 1 } });
      const png = await framed(data, area, Math.round(s.radius(area.width)), pad, background);
      writeFileSync(join(outDir, file), png);
      const bytes = statSync(join(outDir, file)).size;
      console.log(`wrote ${relative(root, join(outDir, file))}: ${area.width * 2}×${(area.height + pad) * 2}, ${(bytes / 1024).toFixed(0)} KB`);
      if (bytes > MAX_BYTES) throw new Error(`readme-shots: ${file} is ${(bytes / 1024).toFixed(0)} KB, over the ${MAX_BYTES / 1024} KB a README picture may weigh`);
    }
  }

  /**
   * The picture in the terminal picture's frame: corners rounded, transparent outside them, and a
   * hairline edge in its colour, so the pictures match on a light page and a dark one. `pad` px of
   * the page's `background` go under the picture, inside the frame.
   */
  async function framed(data, { width, height }, radius, pad = 0, background = 'transparent') {
    const tall = height + pad;
    await send('Emulation.setDeviceMetricsOverride', { width, height: tall, deviceScaleFactor: 2, mobile: false });
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await send('Page.navigate', { url: 'about:blank' });
    await until(`document.readyState === 'complete'`, 'a blank page');
    await evaluate(`(() => {
      document.documentElement.style.background = 'transparent';
      document.body.style.cssText = 'margin:0;background:transparent';
      document.body.innerHTML = '<div style="position:relative;width:${width}px;height:${tall}px;border-radius:${radius}px;overflow:hidden;background:${background}"><img style="display:block;width:${width}px;height:${height}px"><div style="position:absolute;inset:0;border:1px solid #25261d;border-radius:${radius}px"></div></div>';
      const img = document.querySelector('img');
      img.src = 'data:image/png;base64,${data}';
      return img.decode().then(() => true);
    })()`);
    const { data: out } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: tall, scale: 1 } });
    return Buffer.from(out, 'base64');
  }
} finally {
  await browser?.close().catch(() => {});
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
