import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { BrowserState } from './global-setup.js';

/** What the browser tests share: the dashboard global-setup.ts started, how to start another, and how to read a page. */

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'bin', 'shadowlap.js');

let cached: BrowserState | null = null;

/** The dashboard's address, its token and the demo's ids. */
export function dash(): BrowserState {
  if (cached) return cached;
  const file = process.env.SHADOWLAP_BROWSER_STATE;
  if (!file) throw new Error('no dashboard: run the browser tests with npm run test:browser');
  cached = JSON.parse(readFileSync(file, 'utf8')) as BrowserState;
  return cached;
}

/** A demo run or fix by the name runs.json gives it. */
export function demoId(name: string): string {
  const v = dash().runs[name];
  const id = Array.isArray(v) ? v[0] : v;
  if (!id) throw new Error(`the demo store has no ${name}`);
  return id;
}

/**
 * For a read through Playwright's own client (page.request, the request fixture, route.fetch()): sent
 * once more, on a new connection, when the one it reused was closed as it went out. That client keeps
 * a connection alive with no timeout of its own, so it ignores the dashboard's `Keep-Alive: timeout=5`,
 * and Node closes an idle connection about a second after that: a read sent then meets a reset
 * (`read ECONNRESET`). A browser sends such a request again, and this does the same.
 */
export const RESET_RETRY = { maxRetries: 1 } as const;

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

/** A dashboard's address and session token. */
export interface Served {
  origin: string;
  token: string;
}

/**
 * Starts `shadowlap dashboard` in one of the demo's projects as a user would, on a free port, with
 * the demo's machine (its home and its project list), and gives the address and token of the link it
 * prints, with how to stop it. Global setup starts the one every test reads, in support-agent.
 */
export async function serveDashboard(demo: string, project: string): Promise<Served & { stop: () => Promise<void> }> {
  const port = await freePort();
  const env = { ...process.env, SHADOWLAP_HOME: join(demo, 'home'), SHADOWLAP_PROJECT_ROOTS: demo, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0' };
  const child = spawn(process.execPath, [cli, 'dashboard', '--no-open', '--port', String(port)], { cwd: join(demo, project), env, stdio: ['ignore', 'ignore', 'pipe'] });
  const link = await new Promise<string>((resolve, reject) => {
    let said = '';
    // One that prints no link is stopped before the run hears so: no test holds it to stop it later.
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`the dashboard printed no link in 30 s:\n${said}`));
    }, 30_000);
    const hear = (chunk: Buffer) => {
      said += chunk.toString('utf8');
      const m = /(http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+)/.exec(said);
      if (m) {
        clearTimeout(timer);
        // What it says from then on isn't kept: its stream still flows, so it never waits on a full pipe.
        child.stderr.off('data', hear);
        child.stderr.resume();
        resolve(m[1]!);
      }
    };
    child.stderr.on('data', hear);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the dashboard exited (${code}) before printing its link:\n${said}`));
    });
  });
  const url = new URL(link);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  };
  return { origin: url.origin, token: /token=([\w-]+)/.exec(url.hash)![1]!, stop };
}

/** Every link (`#/…`) the shared dashboard's answers write, read from the pages' reads that name runs, fixes and the rest. */
export async function serverLinks(request: APIRequestContext): Promise<Set<string>> {
  const { origin, token } = dash();
  const get = async (path: string) => (await request.get(`${origin}/api/${path}`, { headers: { 'x-shadowlap-token': token }, ...RESET_RETRY })).json();
  const fix = demoId('refundFix');
  const answers = await Promise.all(['summary?tz=UTC', 'activity?limit=200', 'fixes', `fixes/${fix}`, `fixes/${fix}/groups`, 'training', 'tests', `runs/${demoId('override')}/differences`, 'setup', 'projects', 'decisions', `runs/${demoId('refundBug')}/decisions`].map(get));
  const links = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('#/')) links.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  answers.forEach(walk);
  return links;
}

/** The selector that says a page has drawn what it shows. */
const DRAWN: Record<string, string> = {
  overview: 'main#view .ov, main#view .ph',
  runs: 'main#view table.rt tbody tr, main#view .runstable tbody tr, main#view table tbody tr',
  run: 'main#view .rhead .rnm',
  fix: 'main#view .stepper',
};

/** Opens a page of the dashboard (global setup's, or `at`) with the session token, as its printed link does, and waits for it to draw. */
export async function openPage(page: Page, path: string, drawn: string, at: Served = dash()): Promise<void> {
  const { origin, token } = at;
  await page.goto(`${origin}/#token=${token}&open=${path}`);
  await page.waitForSelector(DRAWN[drawn] ?? drawn, { state: 'visible' });
  // Fonts settle the layout that the fitted lines (about lines, hints) are measured against.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(150);
}

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ target: string[]; failureSummary?: string }>;
}

/**
 * axe-core's WCAG 2.2 A and AA rules over the page as it stands. The page runs under a strict CSP
 * that refuses an injected script, so axe is evaluated through the browser's own protocol.
 */
export async function axe(page: Page): Promise<AxeViolation[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: AxeViolation[] }> } };
    const r = await w.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target, ...(n.failureSummary ? { failureSummary: n.failureSummary } : {}) })) }));
  });
}

/** The serious and critical violations, each with where it is: what the tests hold at zero. */
export async function seriousViolations(page: Page): Promise<string[]> {
  // What fades in, a toast, is judged once it has: halfway in, its words sit on a ground it never shows.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  const found = await axe(page);
  return found.filter((v) => v.impact === 'serious' || v.impact === 'critical').flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}${n.failureSummary ? ` · ${n.failureSummary.replace(/\s+/g, ' ').slice(0, 220)}` : ''}`));
}

/**
 * WCAG's contrast ratio between two colours the browser computed: `rgb(…)`, `rgba(…)`, `#rrggbb`, or
 * `color(srgb r g b)`, as Chrome gives a `color-mix()` in sRGB (the grounds and lines are mixes).
 */
export function contrast(a: string, b: string): number {
  const rgb = (c: string): [number, number, number] => {
    const hex = /^#([0-9a-f]{6})$/i.exec(c.trim());
    if (hex) {
      const n = parseInt(hex[1]!, 16);
      return [n >> 16, (n >> 8) & 255, n & 255];
    }
    const srgb = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)/.exec(c.trim());
    if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c);
    if (!m) throw new Error(`not a colour: ${c}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const lum = (c: string) => {
    const [r, g, b2] = rgb(c).map((x) => {
      const v = x / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The element that has the focus, as a short description: its tag, id, classes and text. */
export function focusedLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'body';
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls} “${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}”`;
  });
}

/** Presses Tab until `match` holds for the focused element, at most `max` times; the presses it took. */
export async function tabUntil(page: Page, match: () => boolean, max = 80): Promise<number> {
  for (let n = 1; n <= max; n++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(match)) return n;
  }
  throw new Error(`no match after ${max} presses of Tab; the focus is on ${await focusedLabel(page)}`);
}

/** Asserts no serious or critical axe violation, naming each one found. */
export async function expectAccessible(page: Page): Promise<void> {
  expect(await seriousViolations(page)).toEqual([]);
}

const JOB_ID = 'feedfacefeedface';

/**
 * Starts a replay from `ticket`'s page, the job routes answering for it, so nothing runs: `end` says
 * how the job the page follows ended. Its Replay shows at 1440px; set a narrower window after.
 */
export async function startJob(page: Page, title = 'Replaying') {
  const run = demoId('ticket');
  const job = { id: JOB_ID, kind: 'action', title, args: ['replay', run], worktree: null, runId: run, opensRun: true, startedAt: Date.now(), done: false, stopped: false, code: null as number | null, newRunId: null as string | null, lines: [] as string[], total: 0 };
  const now = { job, started: false };
  await page.route(/\/api\/jobs(\?.*)?$/, (route) => route.fulfill({ json: { jobs: now.started ? [{ ...now.job, lines: undefined }] : [] } }));
  await page.route(/\/api\/runs\/[^/]+\/actions$/, (route) => {
    now.started = true;
    return route.fulfill({ json: now.job });
  });
  await page.route(new RegExp(`/api/jobs/${JOB_ID}/stop`), (route) => route.fulfill({ json: { stopped: false } }));
  await page.route(new RegExp(`/api/jobs/${JOB_ID}(\\?.*)?$`), (route) => route.fulfill({ json: now.job }));
  await openPage(page, `/run/${run}`, 'run');
  await page.locator('.rhead .actions button', { hasText: /^Replay$/ }).click();
  await page.locator('section.drawer').waitFor();
  return {
    run,
    end: (lines: string[], over: Partial<typeof job> = {}) => {
      now.job = { ...job, done: true, code: 0, lines, total: lines.length, ...over };
    },
  };
}
