import { expect, test, type Page } from '@playwright/test';
import { ARTICLES, SMALL } from '../ui/typeset.js';
import { dash, sideways } from './dashboard.js';
import { apiRequests, at, click, DIALOG, escape, MENU, press, ROUTES, run, runs, settled, show, type RouteState } from './routes.js';
import { routeTestsFixture } from './tests-fixture.js';

/**
 * Line breaks at 320, 360, 390 and 430 px on every route of browser/routes.ts, every run of the demo,
 * and every overlay the axe sweep opens (menus, pickers, hover cards, the palette, the shortcuts, a
 * run's inspector tabs, every dialog, a toast, the offline bar, the expired link's card and the token
 * gate), each route loaded fresh at each width and read from the lines the browser drew, as the mock's
 * detector reads them:
 * no word, id or nowrap piece broken inside or past its box (a command's pieces and its `$` among
 * them), no lead or heading line ending on a small word, no control wrapping, a number kept with its
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
  const LEAD = 'main#view .ph h1, main#view .ph p, [role="dialog"] header h3, [role="dialog"] header p, .stepempty h2, .stepempty p, .sec h2';
  const FIXED = '.pnote, .palnote, .toast, .dfacts, .ondisk.steps';
  const INLINE = new Set(['inline', 'contents']);
  const out: string[] = [];
  // A2's rule, read from the stylesheet: the selectors of the nowrap rule that names `.btn` and `.ibtn`.
  const controls = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).find((r): r is CSSStyleRule => r instanceof CSSStyleRule && r.style.whiteSpace === 'nowrap' && /(^|,\s*)\.btn\s*,\s*\.ibtn\b/.test(r.selectorText))?.selectorText;
  if (!controls) out.push('no rule keeping controls on one line in the stylesheet');
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
  // Text nodes by their nearest box that isn't inline: the block whose lines they sit on.
  const blocks = () => {
    const owner = new Map<Element, Text[]>();
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const b = n.textContent?.trim() && !n.parentElement?.closest(SKIP) ? boxOf(n) : null;
      if (b && shown(b) && !/^pre/.test(getComputedStyle(b).whiteSpace)) owner.set(b, [...(owner.get(b) ?? []), n as Text]);
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
  // What ends a line and starts the next: a small word in a lead or heading, a number left by its unit, a dot or an arrow starting a line.
  const breaks = (lines: Word[][], lead: boolean, flag: (kind: string) => void) => {
    for (let i = 0; i < lines.length - 1; i++) {
      const end = lines[i]?.at(-1);
      const next = lines[i + 1]?.[0];
      if (!end || !next) continue;
      const bare = end.w.toLowerCase();
      if (lead && !end.code && SMALL.has(bare) && (ARTICLE.has(bare) || lines.length > 2)) flag(`small “${end.w}”`);
      // A number and its unit are glued in copy; in code (a tool call's JSON) a line breaks at its spaces.
      if ((!end.code && /^[$€£]?\d[\d,.]*[kKmM]?$|^≈$|^~$/.test(end.w) && UNIT.test(next.w)) || /^[≈~$€£]$/.test(end.w) || /^([·→↳|=<>≥≤]|>=|<=|!=)$/.test(next.w)) flag(`glue “${end.w} ${next.w}”`);
    }
  };
  for (const [el, nodes] of blocks()) {
    const words = wordsOf(nodes);
    const lines = linesOf(words);
    const flag = (kind: string) => out.push(`${kind} · ${name(el)} · ${lines.map((l) => l.map((w) => w.w).join(' ')).join(' / ')}`);
    for (const w of words) if (w.lines > 1 && !w.free) flag(`split “${w.w}”`);
    if (lines.length < 2) continue;
    if (controls && el.matches(controls)) flag('wrapped');
    breaks(lines, el.matches(LEAD), flag);
    const last = lines.at(-1);
    if (el.closest(FIXED) && last?.length === 1 && !/^[\d$≈~]/.test(last[0]?.w ?? '')) flag('alone');
  }
  // A piece kept whole that broke anyway, or that runs past its box's right edge.
  for (const el of document.querySelectorAll(NOWRAP)) {
    if (el.closest(SKIP) || !shown(el)) continue;
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
type Step = [name: string, go: () => Promise<void>, read?: true];

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

/** Every billed press asks, whatever the suite's one Spending says, so opening a dialog runs nothing. */
const asking = (page: Page) => page.route('**/api/user/spending', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { askAbove: 0, set: true, problems: [] } }) : route.continue()));

/** A demo run's id by its name. */
const id = (name: string) => dash().runs[name] as string;

/** A menu or a picker opened by a click, read, and closed by Escape. */
const menu = (page: Page, name: string, selector: string, text?: string, shows = MENU): Step[] => [
  [name, click(page, selector, text, { shows }), true],
  [`${name} closed`, escape(page, shows)],
];

/** A dialog opened from its page by its steps, read, and closed by Escape. */
const opened = (page: Page, name: string, where: () => Promise<void>, ...open: Array<() => Promise<void>>): Step[] => [
  [`${name}: its page`, where],
  ...open.map((o, i): Step => (i === open.length - 1 ? [name, o, true] : [`${name}: step ${i + 1}`, o])),
  [`${name}: closed`, escape(page)],
];

/** Tests' Update goldens, as the palette opens it. */
const updateGoldens = (page: Page) => async () => {
  apiRequests(page);
  await page.evaluate(() => {
    location.hash = '#/tests?update';
  });
  await settled(page, { shows: DIALOG });
};

/**
 * The menus, pickers, hover cards, the palette and the shortcuts, a run's inspector tabs, a toast,
 * and the cards that stand for a page: the offline bar, the expired link's card and the token gate.
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
    ['Runs', at(page, '/runs', 'main#view table.runst tbody tr')],
    ['the sidebar', click(page, 'button.menu-toggle', undefined, { shows: 'aside#side.open' }), true],
    ...menu(page, 'the project switcher', 'button.proj'),
    ...menu(page, 'the help menu', '#helpBtn', undefined, '.pop.helpmenu'),
    ['Compare', at(page, '/compare', 'main#view .pickers .rpick')],
    ['a run picker', click(page, '.rpick', undefined, { shows: '.pop.picker' }), true],
    ['a run picker that finds nothing', async () => {
      await page.locator('.pop.picker input.pfilter').fill('zzzz nothing like it');
      await settled(page, { shows: '.pop.picker .pnone' });
    }, true],
    ['a run picker closed', escape(page, '.pop.picker')],
    ['Redaction', at(page, '/settings/redaction', 'main#view .pvhead')],
    ...menu(page, 'Redaction’s run picker', '.pvhead .rpick', undefined, '.pop.picker'),
    ['Add redaction rule', click(page, 'main#view button', 'Add redaction rule', { shows: DIALOG }), true],
    ['Add redaction rule, edited', async () => {
      await page.locator(`${DIALOG} label`, { hasText: 'Replace with' }).locator('input').fill('<GONE>');
      await settled(page);
    }],
    ['Discard what you changed?', press(page, 'Escape', { shows: '.dlgask' }), true],
    ['Discard what you changed? answered', press(page, 'Escape', { hides: '.dlgask' })],
    ...['ticket', 'failTool', 'chat'].flatMap((name): Step[] => [
      [`run ${name}`, run(page, id(name))],
      ...['Response', 'Request', 'Details', 'Conversation'].map((tab): Step => [`run ${name} · inspector ${tab}`, click(page, '.insp [role="tablist"] button', tab, { shows: `.insp [role="tab"][aria-selected="true"]:has-text("${tab}")` }), true]),
    ]),
    ['a run', run(page, ticket)],
    ...menu(page, 'Share', '.rhead .actions button', 'Share'),
    ...menu(page, 'the fork menu', '#forkBtn'),
    ...menu(page, 'More', '#moreBtn'),
    ['a cell’s hover card', async () => {
      await page.locator('.cells button').first().hover();
      await settled(page, { shows: '#tip' });
    }, true],
    ['a fact’s hover card', async () => {
      await page.mouse.move(2, 2);
      await page.locator('main#view .metric .st[data-tip] a').first().focus();
      await settled(page);
    }, true],
    ['a menu row’s hover card', async () => {
      await page.locator('.rhead .actions button', { hasText: 'Share' }).click();
      await page.locator(`${MENU} [role="menuitem"]`).nth(1).hover();
      await settled(page, { shows: '#tip' });
    }, true],
    ['a menu row’s hover card closed', escape(page, MENU)],
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
    ['the palette', press(page, 'Meta+k', { shows: '.palette' }), true],
    ['the palette closed', escape(page, '.palette')],
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

/** Every dialog the demo can show, each opened as its page opens it (as the axe sweep opens them), in two halves. */
function dialogs(page: Page): [Step[], Step[]] {
  // A row or a button that isn't there says so soon: there is no waiting it out.
  const button = (where: string, text: string) => async () => {
    apiRequests(page);
    await page.locator(where, { hasText: text }).first().click({ timeout: 20_000 });
    await settled(page, { shows: DIALOG });
  };
  const tick = async () => {
    await page.locator('main#view table.runst tbody tr input[type="checkbox"]').first().check({ timeout: 20_000 });
    await settled(page, { shows: '.bulkbar' });
  };
  const onRun = (name: string, of: string, text: string) => opened(page, name, run(page, id(of)), button('.rhead .actions button', text));
  const fork = (name: string, of: string, row: string) => opened(page, name, run(page, id(of)), click(page, '#forkBtn', undefined, { shows: MENU }), button(`${MENU} [role="menuitem"]`, row));
  // The call a row belongs to picked first.
  const forkOn = (call: string) => (name: string, of: string, row: string) => opened(page, name, run(page, id(of)), click(page, `main#view tr[data-wi]:has(td.name[title${call}])`), click(page, '#forkBtn', undefined, { shows: MENU }), button(`${MENU} [role="menuitem"]`, row));
  const forkModel = forkOn('^="POST "');
  const forceWrite = (name: string, of: string, tool: string) => forkOn(`="${tool}"`)(name, of, `Force ${tool} live`);
  const share = (name: string, row: string) => opened(page, name, run(page, id('ticket')), click(page, '.rhead .actions button', 'Share', { shows: MENU }), button(`${MENU} [role="menuitem"]`, row));
  const onPage = (name: string, path: string, text: string) => opened(page, name, at(page, path), button('main#view button', text));
  const bulk = (name: string, text: string) => opened(page, name, at(page, '/runs', 'main#view table.runst tbody tr'), tick, button('.bulkbar button', text));
  const onFix = (name: string, of: string, text: string) => opened(page, name, at(page, `/fixes/${id(of)}`, 'fix'), button('.ph .actions button', text));
  const check = (name: string, rule: string) => opened(page, name, run(page, id('refundBug')), click(page, 'main#view tr[data-wi]:has(td.name[title="issue_refund"])'), click(page, '[data-act="ckmenu"]', undefined, { shows: MENU }), button(`${MENU} [role="menuitem"]`, rule));
  return [
    [
      ...opened(page, 'Delete run', run(page, id('ticket')), click(page, '#moreBtn', undefined, { shows: MENU }), button(`${MENU} [role="menuitem"]`, 'Delete run')),
      ...onRun('The consent question', 'packed', 'Replay'),
      ...onRun('Pack as golden', 'digest', 'Pack as golden'),
      ...forkModel('Inject instruction', 'ticket', 'Inject instruction'),
      ...forkModel('Switch model', 'ticket', 'Switch model'),
      ...forkModel('Fail with HTTP status', 'ticket', 'Fail with HTTP status'),
      ...fork('Override result', 'failTool', 'Override result'),
      ...fork('Fail with tool error', 'failTool', 'Fail with tool error'),
      ...fork('Plant instruction', 'failTool', 'Plant instruction'),
      ...forkOn('="user_input"')('Override user reply', 'chat', 'Override user reply'),
      ...fork('Repeat fork 5 times', 'override', 'Repeat 5 times'),
      ...fork('Replay with your command', 'har', 'Replay with your command'),
      ...forkModel('Find commit that changed it', 'ticket', 'Find commit that changed it'),
      ...fork('Find breaking commit', 'planted', 'Find breaking commit'),
      ...forceWrite('Force send_email live', 'twice', 'send_email'),
      ...opened(page, 'Edit and fork', run(page, id('failTool')), button('.insp button', 'Edit and fork')),
      ...check('Add check', 'Never call issue_refund'),
      ...check('Add check: When… then', 'When… then…'),
      ...check('Add check: Ask a judge', 'Ask a judge…'),
    ],
    [
      ...share('Pack', 'Pack'),
      ...share('Export eval dataset', 'Eval dataset'),
      ...share('Export OpenTelemetry trace', 'OpenTelemetry trace'),
      ...bulk('Add label', 'Label'),
      ...bulk('Delete runs', 'Delete'),
      ...bulk('Pack runs', 'Pack'),
      ...bulk('Export the dataset of runs', 'Dataset'),
      ...opened(page, 'Import capture…', at(page, '/runs', 'main#view table.runst tbody tr'), button('main#view button', 'Import capture…')),
      ...opened(page, 'Update goldens', at(page, '/tests'), updateGoldens(page)),
      ...onPage('Update golden', '/tests', 'Update golden'),
      ...onPage('Add normalizer and update', '/tests', 'Add normalizer and update'),
      ...onPage('Run tests’ question', '/tests', 'Run tests'),
      ...onPage('Export pairs', '/training', 'Export pairs'),
      ...onPage('Score model', '/training/tasks', 'Score model'),
      ...onPage('A task’s Update golden', '/training/tasks', 'Update golden'),
      ...onPage('Add normalizer', '/settings/matching', 'Add normalizer'),
      ...onPage('Add MCP server', '/settings/tools', 'Add MCP server'),
      ...onPage('Remove project', '/settings/project', 'Remove project'),
      ...onPage('Write file', '/settings/ci', 'Write file'),
      ...onFix('Run repair', 'emailFix', 'Run repair'),
      ...onFix('Mark fix applied', 'refundFix', 'Mark applied'),
      ...opened(page, 'Rename fix', at(page, `/fixes/${id('emailFix')}`, 'fix'), button('main#view button.fxrename', 'Rename')),
      // Answers the demo can't give, routed for the page's life: last.
      ['Tests with two goldens to update', async () => {
        await routeTestsFixture(page);
        await at(page, '/tests', 'main#view table.gt')();
      }],
      ['Update goldens for two', async () => {
        await click(page, 'main#view button', 'Update goldens', { shows: DIALOG })();
        await expect(page.locator(DIALOG).getByRole('button', { name: 'Add normalizer and update' })).toBeVisible();
      }, true],
      ['Update goldens for two closed', escape(page)],
    ],
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
  test(`the menus, pickers, hover cards, palette, shortcuts, a toast and the connection’s cards at ${width}px break lines only where the rules allow`, async ({ page }) => {
    await asking(page);
    expect(await walk(page, width, overlays(page))).toEqual([]);
  });
  for (const half of [0, 1] as const)
    test(`the ${half ? 'second' : 'first'} half of the dialogs at ${width}px breaks lines only where the rules allow`, async ({ page }) => {
      await asking(page);
      expect(await walk(page, width, dialogs(page)[half])).toEqual([]);
    });
}

/**
 * The owner's example, Settings → Store with no store, at 1440 and 1180: it broke as "…add CI.
 * About fifteen minutes, with nothing to / install or host.", where each sentence sits on a line of
 * its own and neither is split. The plan's four widths are a phone's; this is the one wide case.
 */
test('Store’s two sentences with no store each sit whole on a line of their own at 1440 and 1180', async ({ page }) => {
  // The store read as a project's with none, whatever the demo holds.
  await page.route('**/api/settings/store', async (route) => {
    const res = await route.fetch();
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
