import { rmSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { BASELINE_DEFAULTS, gateResult } from '@shadowlap/engine';
import type { HoldingView } from '../src/cross-project.js';
import type { PreviewNext } from '../src/decision-view.js';
import { evidenceWords } from '../src/tests-evidence.js';
import { gateRuleOf } from '../src/verdict.js';
import { ARTICLES, SMALL } from '../ui/typeset.js';
import type { DecisionSessionDetail, TestsView } from '../ui/types.js';
import { dash, demoId, RESET_RETRY, serveDashboard, sideways, type Served } from './dashboard.js';
import { buildInjectionStore, type InjectionStore } from './injection-fixture.js';
import { asksFirst, at, cardStates, click, DIALOG, dialogWalk, escape, fixes, injectionRoutes, menu, overlayStates, press, PREVIEW, previewed, ROUTES, run, runs, settled, show, type RouteState, type State } from './routes.js';
import { routeTestsFixture } from './tests-fixture.js';

/**
 * Line breaks at 320, 360, 390 and 430 px on every route of browser/routes.ts (an injection test's
 * pages on a store of their own), every run of the demo, and the overlays and dialogs routes.ts walks
 * for both sweeps (menus, pickers, hover cards, the palette, the shortcuts, every dialog), with a
 * run's inspector tabs, a toast, the offline bar, the expired link's card and the token gate, each
 * route loaded fresh at each width and read from the lines the browser drew, as the mock's detector
 * reads them:
 * no word, id or nowrap piece broken inside or past its box (a command's pieces and its `$` among
 * them), no lead or heading line ending on a small word (each read whole, whatever its copy draws
 * inside it), no control or field label wrapping, a number kept with its
 * unit and a dot or an arrow with the word before it, no last word alone in text of a fixed width
 * (a menu's note, a toast, a dialog's rows and steps), and at 360 and 430 nothing scrolling sideways
 * (port/a11y-sweep checks 390 and 320). Only `.sr` and `[hidden]` are passed over of what a screen
 * reader skips, never aria-hidden text; of the rest, what the copy rules leave as written: `pre`-like
 * text (JSON, a prompt, a patch, a log), fields, and the fitted lines (`[data-about]`, `[data-fit]`).
 * The breaks the rules allow are allowed: a long name's or a long path's pieces (`ts-w.ts-long`,
 * `code.ts-cb`) where the line can't hold it whole, a command's argument (`.carg`) likewise, and
 * free words (`ts-w.ts-free`), so `s3://…` breaking after a slash at 360 to 430 is no flag.
 */

test.describe.configure({ timeout: 300_000 });

// A route may still be reading the server's answer as a test ends; the page's close takes it away, and that is no failure.
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

const WIDTHS = [320, 360, 390, 430];
/** port/a11y-sweep checks sideways scroll at 390 and 320. */
const SIDEWAYS = new Set([360, 430]);

interface Rules {
  small: string[];
  articles: string[];
}

/** A word as drawn: its text, where its first box sits, on how many lines its boxes sit, and whether it may break or is code. */
interface Word {
  w: string;
  top: number;
  bottom: number;
  lines: number;
  free: boolean;
  code: boolean;
}

/** Every flag on the page as drawn: `kind · where · its lines`. Its parts are inside it, as `page.evaluate` sends it alone. */
function measure(rules: Rules): string[] {
  const SMALL = new Set(rules.small);
  const ARTICLE = new Set(rules.articles);
  const UNIT = /^(ms|s|min|minutes?|hours?|days?|weeks?|calls?|runs?|attempts?|tokens?|%|KB|MB|GB|B|requests?|steps?|goldens?|checks?|fixes?|tests?|turns?|forks?|cents?|seconds?|items?|tools?|times|probes?|commits?|files?|candidates?|rules?|x|×)[,.;:)]?$/i;
  // What the copy rules leave as written, as the mock's typesetter does (its TS_DATA): a model's answer, a message, a
  // prompt, JSON, the raw stream and the provenance ledger are data, and break where a browser breaks them.
  const SKIP = '.sr, [hidden], pre, svg, script, style, textarea, input, select, [data-about], [data-fit], .say, .dsay, .msg .txt, .think, .pat, .jbox, .rawsse, table.ledger';
  const FREE = 'ts-w.ts-long:not(.whole), code.ts-cb:not(.whole), .carg:not(.whole), ts-w.ts-free';
  const NOWRAP = 'code.rnm, ts-w:not(.ts-long):not(.ts-free), ts-w.ts-long.whole, .nw, code.ts-code, .carg.whole, .cf, .cmdp';
  // A field's note isn't a lead: the model field's note under Migrate's form says why a provider couldn't be listed, as Setup's
  // field notes say theirs, and holds what failed as the server said it, kept as written.
  const LEAD = 'main#view .ph h1, main#view .ph p, [role="dialog"] header h3, [role="dialog"] header p, .stepempty h2, .stepempty p:not(.dlgnote), .sec h2, ol.setup .sb > h2, ol.setup .sb > p:not(.fieldnote)';
  // A field's own label words beside its control: a form's label over its input, select or textarea, a Settings row's name.
  const LABELS = '.form label, .setrow b[id$="-name"]';
  const FIXED = '.pnote, .palnote, .toast, .dfacts, .ondisk.steps';
  const INLINE = new Set(['inline', 'contents']);
  const out: string[] = [];
  // A2's rule, read from the stylesheet: the selectors of the nowrap rule that names `.btn` and `.ibtn`.
  const controls = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).find((r): r is CSSStyleRule => r instanceof CSSStyleRule && r.style.whiteSpace === 'nowrap' && /(^|,\s*)\.btn\s*,\s*\.ibtn\b/.test(r.selectorText))?.selectorText;
  if (!controls) out.push('no rule keeping controls on one line in the stylesheet');
  const oneLine = [controls, LABELS].filter(Boolean).join(', ');
  const shown = (el: Element) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
  const name = (el: Element) => {
    const id = el.closest('[id]');
    const cls = String(el.className).trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return `${id ? `#${id.id} ` : ''}${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
  };
  const tops = (rects: Iterable<DOMRect>) => new Set([...rects].filter((r) => r.width > 0.5).map((r) => Math.round(r.top))).size;
  const boxOf = (el: Node) => {
    let b = el.parentElement;
    while (b && INLINE.has(getComputedStyle(b).display)) b = b.parentElement;
    return b;
  };
  // The text under an element that holds words, none of what the sweep passes over.
  const textsIn = (root: Node) => {
    const nodes: Text[] = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent?.trim() && !n.parentElement?.closest(SKIP)) nodes.push(n as Text);
    return nodes;
  };
  // Text nodes by their nearest box that isn't inline: the block whose lines they sit on.
  const blocks = () => {
    const owner = new Map<Element, Text[]>();
    for (const n of textsIn(document.body)) {
      const b = boxOf(n);
      if (b && shown(b) && !/^pre/.test(getComputedStyle(b).whiteSpace)) owner.set(b, [...(owner.get(b) ?? []), n]);
    }
    return owner;
  };
  const range = document.createRange();
  const wordsOf = (nodes: Text[]) =>
    nodes.flatMap((t) => {
      const free = !!t.parentElement?.closest(FREE);
      const code = !!t.parentElement?.closest('code, kbd, samp');
      return [...(t.textContent ?? '').matchAll(/\S+/g)].flatMap((m): Word[] => {
        range.setStart(t, m.index);
        range.setEnd(t, m.index + m[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
        const first = rects[0];
        return first ? [{ w: m[0], top: first.top, bottom: first.bottom, lines: tops(rects), free, code }] : [];
      });
    });
  // A new line where a word starts below the middle of the word before it.
  const linesOf = (words: Word[]) => {
    const lines: Word[][] = [];
    let prev: Word | undefined;
    for (const w of words) {
      if (!prev || w.top > (prev.top + prev.bottom) / 2) lines.push([]);
      lines[lines.length - 1]?.push(w);
      prev = w;
    }
    return lines;
  };
  // What ends a line and starts the next: a number left by its unit, a dot or an arrow starting a line.
  const glues = (lines: Word[][], flag: (kind: string) => void) => {
    for (let i = 0; i < lines.length - 1; i++) {
      const end = lines[i]?.at(-1);
      const next = lines[i + 1]?.[0];
      if (!end || !next) continue;
      // A number and its unit are glued in copy; in code (a tool call's JSON) a line breaks at its spaces.
      if ((!end.code && /^[$€£]?\d[\d,.]*[kKmM]?$|^≈$|^~$/.test(end.w) && UNIT.test(next.w)) || /^[≈~$€£]$/.test(end.w) || /^([·→↳|=<>≥≤]|>=|<=|!=)$/.test(next.w)) flag(`glue “${end.w} ${next.w}”`);
    }
  };
  // A small word ending a line of a lead or a heading: never an article or a possessive, nor any in a block of more than two lines.
  const smallEnds = (lines: Word[][], flag: (kind: string) => void) => {
    for (const line of lines.slice(0, -1)) {
      const end = line.at(-1);
      const bare = end?.w.toLowerCase() ?? '';
      if (end && !end.code && SMALL.has(bare) && (ARTICLE.has(bare) || lines.length > 2)) flag(`small “${end.w}”`);
    }
  };
  const said = (lines: Word[][]) => lines.map((l) => l.map((w) => w.w).join(' ')).join(' / ');
  // A lead or a heading read as one block, whatever its copy draws inside it (a sentence or a word kept whole is an inline block).
  const leads = () => {
    for (const el of document.querySelectorAll(LEAD)) {
      if (el.closest(SKIP) || !shown(el)) continue;
      const lines = linesOf(wordsOf(textsIn(el)));
      smallEnds(lines, (kind) => out.push(`${kind} · ${name(el)} · ${said(lines)}`));
    }
  };
  for (const [el, nodes] of blocks()) {
    const words = wordsOf(nodes);
    const lines = linesOf(words);
    const flag = (kind: string) => out.push(`${kind} · ${name(el)} · ${said(lines)}`);
    for (const w of words) if (w.lines > 1 && !w.free) flag(`split “${w.w}”`);
    if (lines.length < 2) continue;
    if (el.matches(oneLine)) flag('wrapped');
    glues(lines, flag);
    const last = lines.at(-1);
    if (el.closest(FIXED) && last?.length === 1 && !/^[\d$≈~]/.test(last[0]?.w ?? '')) flag('alone');
  }
  leads();
  // A piece kept whole that broke anyway, or that runs past its box's right edge.
  // A `.nw` the stylesheet lets wrap where it is (the feed's what at 340px and under, as the mock has it) isn't kept whole there.
  const kept = (el: Element) => !el.matches('.nw') || getComputedStyle(el).whiteSpace === 'nowrap';
  for (const el of document.querySelectorAll(NOWRAP)) {
    if (el.closest(SKIP) || !shown(el) || !kept(el)) continue;
    const right = Math.max(...[...el.getClientRects()].map((r) => r.right));
    const box = boxOf(el);
    if (tops(el.getClientRects()) > 1) out.push(`broken · ${name(el)} · ${el.textContent}`);
    else if (box && right > box.getBoundingClientRect().right + 1) out.push(`past its box · ${name(el)} · ${el.textContent}`);
  }
  return [...new Set(out)];
}

const RULES: Rules = { small: [...SMALL], articles: [...ARTICLES] };

/** A state's flags as drawn, under the width and its name: read once the fonts have loaded and Copy has measured again. */
async function read(page: Page, width: number, name: string): Promise<string[]> {
  // Copy measures again once the fonts have loaded and after its ResizeObserver: two frames after that.
  await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
  const found = (await page.evaluate(measure, RULES)).map((f) => `${width} · ${name} · ${f}`);
  if (SIDEWAYS.has(width)) {
    const past = await sideways(page);
    if (past > 0) found.push(`${width} · ${name} · the page scrolls ${past}px sideways`);
  }
  return found;
}

/** A step of a walk: its name in a failure, how to take it, and whether what it shows is read (a page on the way there is the routes'). */
type Step = State;

/** Each flag at a width over the steps given in turn, under the name of the step that showed it. */
async function walk(page: Page, width: number, steps: readonly Step[]): Promise<string[]> {
  await page.setViewportSize({ width, height: 800 });
  let crashed = false;
  page.on('crash', () => (crashed = true));
  const found: string[] = [];
  for (const [name, go, look] of steps) {
    try {
      await go();
    } catch (err) {
      found.push(`${width} · ${name} · didn’t ${look ? 'show' : 'load'}${crashed ? ': the page crashed' : ''}: ${String(err).split('\n')[0]}`);
      if (crashed) break;
      continue;
    }
    if (look) found.push(...(await read(page, width, name)));
  }
  return found;
}

/** Every route given, each loaded fresh and read. */
const routeSteps = (page: Page, routes: readonly RouteState[]): Step[] => routes.map((r): Step => [r.name, show(page, r), true]);

/**
 * Every run of the demo, each on its own address, and every view of the runs the routes' table
 * doesn't show in each: a capture's (litellm's), a chat's, an eval's and a batch's fork. Each run's
 * findings and notes are its own.
 */
const runSteps = (page: Page): Step[] => [
  ...runs().map(([name, of]): Step => [`run ${name}`, run(page, of), true]),
  ...['batchFork', 'eval', 'litellm', 'chat'].flatMap((name) => ['turns', 'context', 'timeline', 'forks', 'provenance', 'decisions'].map((v): Step => [`run ${name} · ${v}`, run(page, id(name), v), true])),
];

/** Each step of a fix's page: its own, then Blame, Repair and Verify. The routes' table has the first fix's; these are the rest. */
const STEPS = ['', '/blame', '/repair', '/verify'];
const fixSteps = (page: Page): Step[] =>
  fixes()
    .filter((f) => f !== id('refundFix'))
    .flatMap((f) => STEPS.map((s): Step => [`fix ${f}${s ? ` · ${s.slice(1)}` : ''}`, at(page, `/fixes/${f}${s}`, 'fix'), true]));

/** Tests with a golden decided against its history, so its footer states the history gate's rule: the demo's goldens have none. */
async function routeHistoryGate(page: Page): Promise<void> {
  const decided = gateResult({ kind: 'baseline', ...BASELINE_DEFAULTS }, Array<boolean>(8).fill(true), { history: { attempts: 50, passes: 48, sessions: 10 } });
  const gate = { ...decided, tally: '8 of 8 passed', rule: gateRuleOf(decided), perAttempt: null, more: null, words: evidenceWords(decided, null) };
  await page.route(
    (url) => url.pathname === '/api/tests',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch(RESET_RETRY);
      const real = (await res.json()) as TestsView;
      const one = real.rows.find((r) => r.last.verdict === 'passed') ?? real.rows[0];
      return route.fulfill({ response: res, json: { ...real, rows: real.rows.map((r) => (r === one ? { ...r, last: { ...r.last, gate } } : r)) } });
    },
  );
}

/** The demo's preview with Migrate as its one next step, so its button asks Migrate's one ask: the demo's offers Verify. */
async function routeMigrateNext(page: Page): Promise<string> {
  const { preview } = await previewed(page);
  const session = preview.split('/').pop()!;
  await page.route(
    (url) => url.pathname === `/api/decisions/${session}`,
    async (route) => {
      const res = await route.fetch(RESET_RETRY);
      const real = (await res.json()) as DecisionSessionDetail;
      const next: PreviewNext = { verify: null, more: null, migrate: { to: 'claude-sonnet-5', from: ['claude-sonnet-4-5'], goldens: ['goldens/refund-flow'], runs: [] } };
      return route.fulfill({ response: res, json: { ...real, view: { ...real.view, next } } });
    },
  );
  return preview;
}

/**
 * A link into another project (pages/Elsewhere.tsx): the demo's triage-bot named as holding any
 * session the address names that support-agent's store doesn't, as a second project's store would.
 */
async function routeHeldElsewhere(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/projects/holding',
    async (route) => {
      const res = await route.fetch(RESET_RETRY);
      const real = (await res.json()) as HoldingView;
      const id = new URL(route.request().url()).searchParams.get('id') ?? '';
      return route.fulfill({ response: res, json: { ...real, held: real.held ?? { project: { id: 'triage-bot', name: 'triage-bot' }, id } } });
    },
  );
}

/** The page that says another project holds what the link names, drawn once the holding read has answered. */
const HELD = 'main#view .ph .eyebrow:has-text("in another project")';

/** What the demo can't draw, by answers routed for the page's life: last. */
const unshown = (page: Page): Step[] => [
  ['Tests with a history gate’s rule', async () => {
    await routeHistoryGate(page);
    await at(page, '/tests', 'main#view .gfoot')();
  }, true],
  ['a preview whose next step is Migrate', async () => {
    await at(page, await routeMigrateNext(page), PREVIEW)();
  }],
  ['Migrate’s one ask', click(page, 'main#view button', 'Migrate to', { shows: DIALOG }), true],
  ['Migrate’s one ask closed', escape(page)],
  ['a migration another project holds', async () => {
    await routeHeldElsewhere(page);
    await at(page, '/changes/migrate/mg-01M5000000000000000000000Z', HELD)();
  }, true],
  ['a preview another project holds', at(page, '/changes/decisions/dc-01M5000000000000000000000Z', HELD), true],
];

/** A demo run's id by its name. */
const id = demoId;

/**
 * The overlays both sweeps open (routes.ts), the sidebar first as on any phone, and their hover
 * cards; then what only this sweep reads: the help menu, a run's inspector tabs, the check menu, the
 * shortcuts on pages of each kind, the palette on a row's actions and with results, a toast, and the
 * cards that stand for a page: the token gate, the offline bar and the expired link's card.
 */
function overlays(page: Page): Step[] {
  const ticket = id('ticket');
  const { origin, token } = dash();
  const state = (name: string, path: string, drawn: string): Step => [
    name,
    async () => {
      await page.goto(`${origin}${path}`);
      await settled(page, { shows: drawn });
    },
    true,
  ];
  return [
    // First, while the page holds no session token: the address opened without one.
    state('the token gate', '/', '.connblock.gate'),
    ...overlayStates(page, '', true),
    ...cardStates(page),
    ...menu(page, 'the help menu', '#helpBtn', undefined, '.pop.helpmenu'),
    ...['ticket', 'failTool', 'chat'].flatMap((name): Step[] => [
      [`run ${name}`, run(page, id(name))],
      ...['Response', 'Request', 'Details', 'Conversation'].map((tab): Step => [`run ${name} · inspector ${tab}`, click(page, '.insp [role="tablist"] button', tab, { shows: `.insp [role="tab"][aria-selected="true"]:has-text("${tab}")` }), true]),
    ]),
    ['run refundBug', run(page, id('refundBug'))],
    ['run refundBug · a tool call', click(page, 'main#view tr[data-wi]:has(td.name[title="issue_refund"])')],
    ...menu(page, 'the check menu', '[data-act="ckmenu"]'),
    // The shortcuts on pages of each kind: the keys that don't apply there are listed apart.
    ...([['the Overview', '/', 'overview'], ['a run', `/run/${ticket}`, 'run'], ['Fixes', '/fixes', 'main#view'], ['Settings', '/settings/ci', 'main#view']] as const).flatMap(([where, path, drawn]): Step[] => [
      [where, at(page, path, drawn)],
      [`the shortcuts on ${where}`, press(page, '?', { shows: '.help' }), true],
      [`the shortcuts on ${where} closed`, escape(page, '.help')],
    ]),
    ['Runs', at(page, '/runs', 'main#view table.runst tbody tr')],
    ['Runs · a run ticked', async () => {
      await page.locator('main#view table.runst tbody tr input[type="checkbox"]').first().check();
      await settled(page, { shows: '.bulkbar' });
    }, true],
    // With the focus in the row, ⌘K opens on the row's actions; ⌫ goes back to everything, and the hits in what was recorded come from the server.
    ['the palette on a row’s actions', press(page, 'Meta+k', { shows: '.palette' }), true],
    ['the palette with results', async () => {
      await page.keyboard.press('Backspace');
      await page.keyboard.type('refund');
      await page.locator('#palList', { hasText: 'In recorded data' }).waitFor();
      await settled(page);
    }, true],
    ['the palette with results closed', escape(page, '.palette')],
    // A toast with Undo: the good key pressed on a run, then put back with u.
    ['a run, for its toast', run(page, ticket)],
    ['a toast with Undo', click(page, '.rhead .runkey button', 'good', { shows: '.toast button:has-text("Undo")' }), true],
    ['the toast’s Undo', press(page, 'u')],
    // The cards that stand for a page, in the connection's preview that stops no server.
    state('the offline bar', `/?state=offline#token=${token}&open=/run/${ticket}`, '.connbar'),
    state('the expired link’s card', `/?state=expired#token=${token}&open=/tests`, '.connblock'),
  ];
}

/**
 * The dialogs both sweeps open (routes.ts' dialogWalk), each as its page opens it, in two halves,
 * so the suite's workers share them; the second ends with Update goldens for two goldens, whose
 * answers are routed for the page's life (tests-fixture.ts), last.
 */
async function dialogs(page: Page, half: 0 | 1): Promise<Step[]> {
  const groups = (await dialogWalk(page))();
  const at2 = Math.ceil(groups.length / 2);
  if (!half) return groups.slice(0, at2).flat();
  return [
    ...groups.slice(at2).flat(),
    ['Tests with two goldens to update', async () => {
      await routeTestsFixture(page);
      await at(page, '/tests', 'main#view table.gt')();
    }],
    ['Update goldens for two', async () => {
      await click(page, 'main#view button', 'Update goldens', { shows: DIALOG })();
      await expect(page.locator(DIALOG).getByRole('button', { name: 'Add normalizer and update' })).toBeVisible();
    }, true],
    ['Update goldens for two closed', escape(page)],
  ];
}

// Each width's routes in two halves, its overlays, and its dialogs in two halves, so the suite's
// workers share the sweep and each test stays short; the routes the table answers by fixture come
// last, in the second half, as they stay routed for the page's life.
const HALF = Math.ceil(ROUTES.length / 2);
for (const width of WIDTHS) {
  test(`the first half of the routes at ${width}px breaks lines only where the rules allow`, async ({ page }) => {
    expect(await walk(page, width, routeSteps(page, ROUTES.slice(0, HALF)))).toEqual([]);
  });
  test(`the second half of the routes at ${width}px breaks lines only where the rules allow`, async ({ page }) => {
    expect(await walk(page, width, routeSteps(page, ROUTES.slice(HALF)))).toEqual([]);
  });
  test(`every run of the demo, and every view of a few more, at ${width}px breaks lines only where the rules allow`, async ({ page }) => {
    expect(await walk(page, width, runSteps(page))).toEqual([]);
  });
  test(`every fix’s steps, a history gate’s rule, Migrate’s one ask and a session another project holds at ${width}px break lines only where the rules allow`, async ({ page }) => {
    await asksFirst(page);
    expect(await walk(page, width, [...fixSteps(page), ...unshown(page)])).toEqual([]);
  });
  test(`the menus, pickers, hover cards, palette, shortcuts, a toast and the connection’s cards at ${width}px break lines only where the rules allow`, async ({ page }) => {
    await asksFirst(page);
    expect(await walk(page, width, overlays(page))).toEqual([]);
  });
  for (const half of [0, 1] as const)
    test(`the ${half ? 'second' : 'first'} half of the dialogs at ${width}px breaks lines only where the rules allow`, async ({ page }) => {
      await asksFirst(page);
      expect(await walk(page, width, await dialogs(page, half))).toEqual([]);
    });
}

/**
 * An injection test's pages (routes.ts' injectionRoutes) at each width, on a store real commands made
 * for them with testing's mock model (injection-fixture.ts) and a dashboard of their own, stopped
 * after: one test for the four widths, so every width's flags are read, as one store serves them.
 */
test.describe('an injection test’s pages', () => {
  let built: InjectionStore | null = null;
  let served: (Served & { stop: () => Promise<void> }) | null = null;
  test.beforeAll(async () => {
    // Four commands on a mock model, a few seconds, then the dashboard.
    test.setTimeout(120_000);
    built = await buildInjectionStore();
    served = await serveDashboard(built.folder, built.project);
  });
  test.afterAll(async () => {
    await served?.stop();
    served = null;
    if (built) rmSync(built.folder, { recursive: true, force: true });
    built = null;
  });
  test(`at ${WIDTHS.join(', ')}px break lines only where the rules allow`, async ({ page }) => {
    if (!built || !served) throw new Error('the injection store was not built');
    const found: string[] = [];
    for (const width of WIDTHS) found.push(...(await walk(page, width, routeSteps(page, injectionRoutes(served, built.runId)))));
    expect(found).toEqual([]);
  });
});

/**
 * The owner's example, Settings → Store with no store, at 1440 and 1180: it broke as "…add CI.
 * About fifteen minutes, with nothing to / install or host.", where each sentence sits on a line of
 * its own and neither is split. The plan's four widths are a phone's; this is the one wide case.
 */
test('Store’s two sentences with no store each sit whole on a line of their own at 1440 and 1180', async ({ page }) => {
  // The store read as a project's with none, whatever the demo holds.
  await page.route('**/api/settings/store', async (route) => {
    const res = await route.fetch(RESET_RETRY);
    await route.fulfill({ response: res, json: { ...(await res.json()), configured: false, status: null } });
  });
  for (const width of [1440, 1180]) {
    await page.setViewportSize({ width, height: 900 });
    await at(page, '/settings/store', 'main#view .settab .stepempty p')();
    await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
    const lines = await page.locator('main#view .settab .stepempty p ts-s').evaluateAll((sentences) =>
      sentences.map((s) => {
        const tops = new Set([...s.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
        return { text: s.textContent?.replace(/\u00a0/g, ' ').trim(), lines: tops.size, top: Math.min(...tops) };
      }),
    );
    expect(lines.map(({ text, lines: n }) => ({ text, lines: n })), `at ${width}`).toEqual([
      { text: 'Connect a bucket you own, push your runs and add CI.', lines: 1 },
      { text: 'About fifteen minutes, with nothing to install or host.', lines: 1 },
    ]);
    expect(lines[1]!.top, `at ${width}, the second sentence under the first`).toBeGreaterThan(lines[0]!.top);
  }
});
