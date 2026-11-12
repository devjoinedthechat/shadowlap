import { expect, test, type Page } from '@playwright/test';
import { parseRoute, routeHref } from '../ui/route.js';
import { runsLinkQuery } from '../ui/runspage/query.js';
import { contrast, dash, demoId, focusedLabel, openPage, serverLinks, seriousViolations, tabUntil } from './dashboard.js';

/**
 * The dashboard in Chromium over the demo store, as a person with a keyboard or a screen reader
 * meets it: no serious or critical axe violation on the pages a user lands on most, text that
 * reaches AA contrast, a skip link first, a focus order that follows the page, focus rings drawn
 * whole in scrolling panes, the palette as a combobox, and every overlay keeping and returning the
 * focus. And every link the server writes opens a page the dashboard has.
 */

const PAGES: Array<{ name: string; path: () => string; drawn: string }> = [
  { name: 'the Overview', path: () => '/', drawn: 'main#view .ovg' },
  { name: 'Runs', path: () => '/runs', drawn: 'main#view table.runst tbody tr' },
  { name: 'Runs › Failed', path: () => '/runs?types=failed', drawn: 'main#view table.issues tbody tr' },
  { name: 'a run', path: () => `/run/${demoId('refundBug')}`, drawn: 'run' },
  { name: 'a fork', path: () => `/run/${demoId('override')}`, drawn: 'run' },
  { name: 'a fix', path: () => `/fixes/${demoId('refundFix')}`, drawn: 'fix' },
];

for (const p of PAGES) {
  test(`${p.name} has no serious or critical axe violation`, async ({ page }) => {
    await openPage(page, p.path(), p.drawn);
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('the Overview has no serious or critical axe violation on a laptop or a phone, Usage folded or open, a phone never scrolls it sideways, and no row runs past its panel', async ({ page }) => {
  const usage = page.locator('main#view .ovuse > header button.linkbtn');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await openPage(page, '/', 'main#view .ovg');
    // Usage is kept open for the session once asked for: each width starts it folded.
    if ((await usage.getAttribute('aria-expanded')) === 'true') await usage.click();
    await expect(usage).toHaveText('Show');
    expect(await seriousViolations(page)).toEqual([]);
    await usage.click();
    await page.waitForSelector('main#view .ovuse .ugrid');
    expect(await usage.getAttribute('aria-expanded')).toBe('true');
    expect(await seriousViolations(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `at ${width}px`).toBe(0);
    // A piece too long for any line, as the demo project's path in its Project added entry, breaks where it must.
    const past = await page.evaluate(() => [...document.querySelectorAll('main#view .feed .w, main#view .arow .at')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
    expect(past, `at ${width}px`).toEqual([]);
  }
});

/** The run's findings bar opened, as `N findings` (or `Details`) opens it: the findings it folds, a note's tools and hint, and the fork's changes show. */
async function openFindings(page: Page) {
  const more = page.locator('main#view .findings .fmore');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
}

test('a fork’s page says what it did differently, and has no serious or critical axe violation with it', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await openFindings(page);
  await page.waitForSelector('.findings .fdiff h2');
  expect(await page.textContent('.fdiff h2')).toBe('What the fork did differently');
  expect(await seriousViolations(page)).toEqual([]);
});

test('a fork’s writes and a kept run’s baseline wrap: a phone shows the fork, and a laptop the fix’s runs, with nothing running past them', async ({ page }) => {
  // A phone: the fork's page is no wider than the phone, its writes' arguments wrapped.
  await page.setViewportSize({ width: 390, height: 900 });
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await openFindings(page);
  await page.waitForSelector('.fdiff .fdw code');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  // A laptop: the table of the runs a fix was verified on doesn't scroll sideways for a good run's baseline.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPage(page, `/fixes/${demoId('refundFix')}/verify`, 'fix');
  const table = page.locator('main#view section.panel.tscroll', { has: page.locator('.fxbase') }).first();
  await table.waitFor();
  expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
});

for (const width of [1440, 390])
  test(`the fix’s steps show a row’s attempts under it on request, grouped by what each did, with no serious or critical axe violation, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // A verified run's attempts, then the blamed probe's: each row's Attempts cell opens them under it.
    for (const [step, table] of [['verify', 'table.vruns'], ['blame', 'table.probes']] as const) {
      await openPage(page, `/fixes/${demoId('refundFix')}/${step}`, 'fix');
      const toggle = page.locator(`main#view ${table} tbody tr:not(.sub) button.xbtn`).first();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const under = page.locator(`main#view ${table} tr.sub`).first();
      await expect(under.locator('.alist > .al').first()).toBeVisible();
      await expect(under.locator('.agroups li').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      expect(await seriousViolations(page)).toEqual([]);
    }
  });

/** Text tokens, and the surfaces text is drawn on, as the browser computed them on the page. */
const TEXT = ['--ink', '--dim', '--faint', '--err', '--warn', '--accent', '--o-rep', '--o-over', '--o-stub', '--o-block', '--k-write', '--c-write', '--del', '--add'];
const SURFACES = ['--bg', '--bg2', '--panel', '--raise', '--hover', '--sel', '--code', '--pop'];

test('every text colour reaches 4.5:1 on the page and on every panel, and a field’s edge 3:1, as the browser draws them', async ({ page }) => {
  await openPage(page, '/', 'main#view .ovg');
  // Each token as the browser draws it: set as an element's colour and read back, a mix worked out.
  const tokens = await page.evaluate((names) => {
    const probe = document.body.appendChild(document.createElement('i'));
    const out = Object.fromEntries(
      names.map((n) => {
        probe.style.color = `var(${n})`;
        return [n, getComputedStyle(probe).color];
      }),
    );
    probe.remove();
    return out;
  }, [...TEXT, ...SURFACES, '--field']);
  const low: string[] = [];
  for (const t of TEXT) for (const s of SURFACES) if (contrast(tokens[t]!, tokens[s]!) < 4.5) low.push(`${t} on ${s}: ${contrast(tokens[t]!, tokens[s]!).toFixed(2)}`);
  for (const s of ['--bg', '--pop', '--bg2', '--panel']) if (contrast(tokens['--field']!, tokens[s]!) < 3) low.push(`--field on ${s}: ${contrast(tokens['--field']!, tokens[s]!).toFixed(2)}`);
  expect(low).toEqual([]);
  // And faint text where it is drawn, on what is under it.
  const pairs = await page.evaluate(() => {
    const faint = getComputedStyle(document.documentElement).getPropertyValue('--faint').trim();
    const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    const out: Array<[string, string]> = [];
    for (const el of document.querySelectorAll<HTMLElement>('main#view *, aside#side *')) {
      const s = getComputedStyle(el);
      if (s.color !== rgb(faint) || !el.textContent?.trim() || !el.getClientRects().length) continue;
      let bg = 'rgba(0, 0, 0, 0)';
      for (let n: HTMLElement | null = el; n && /rgba\(0, 0, 0, 0\)|transparent/.test(bg); n = n.parentElement) bg = getComputedStyle(n).backgroundColor;
      out.push([s.color, bg]);
    }
    return out;
  });
  expect(pairs.length).toBeGreaterThan(20);
  for (const [fg, bg] of pairs) if (!/rgba\(.*, 0\)$/.test(bg)) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
});

/** Which part of the page the focus is in. */
const region = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    if (el.classList.contains('skip')) return 'skip';
    if (el.closest('header.top, .top')) return 'top';
    if (el.closest('aside#side')) return 'side';
    if (el.closest('main#view')) return 'main';
    return 'other';
  });

test('Skip to content is the first stop for Tab, shows when it has the focus, and takes it to the page’s heading', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.keyboard.press('Tab');
  expect(await focusedLabel(page)).toContain('Skip to content');
  const box = (await page.locator('a.skip').boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.height).toBeGreaterThan(10);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.matches('main#view h1'))).toBe(true);
  // The run's own actions are a few presses away, not the 53rd stop they were. In the design's order they
  // come after what the eye reads beside them: the id, Copy ID, the good/bad key, a label's × and Add label,
  // then each fact with a card (the outcome, calls, spent, not re-spent, not waited), then Share.
  const presses = await tabUntil(page, () => document.activeElement?.textContent?.trim() === 'Replay', 15);
  expect(presses).toBeLessThanOrEqual(13);
});

test('Tab goes through the top bar, then the sidebar, then the page, never back', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const order = ['skip', 'top', 'side', 'main'];
  const seen: string[] = [];
  for (let i = 0; i < 90; i++) {
    await page.keyboard.press('Tab');
    const at = await region(page);
    if (seen.at(-1) !== at) seen.push(at);
    if (at === 'main') break;
  }
  expect(seen.filter((x) => order.includes(x))).toEqual(order);
});

test('a focus ring in a pane that scrolls is drawn inside the control, so the pane cuts none of it off, and a raw stream rings inside itself', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.waitForSelector('aside#side .runs a.run');
  // The sidebar's runs, and a run's calls: rows flush with their scrolling pane's edges.
  for (const sel of ['aside#side .runs a.run', 'main#view .vbody button, main#view .vbody a']) {
    await page.focus(sel);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      const pane = (() => {
        for (let n = el.parentElement; n; n = n.parentElement) if (/(auto|scroll)/.test(getComputedStyle(n).overflowY + getComputedStyle(n).overflowX)) return n;
        return null;
      })();
      const r = el.getBoundingClientRect();
      const out = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset);
      const p = pane!.getBoundingClientRect();
      return { style: s.outlineStyle, offset: s.outlineOffset, inside: r.left - out >= p.left - 0.5 && r.right + out <= p.right + 0.5 && r.top - out >= p.top - 0.5 };
    });
    expect(ring, sel).toEqual({ style: 'solid', offset: '-2px', inside: true });
  }
  // A streamed model call's Raw view: the stream scrolls in a box of its own, a Tab stop whose ring is drawn inside it.
  await openPage(page, `/run/${demoId('refundBug')}`, 'run');
  await page.locator('main#view tr[data-wi]:has(td.name[title^="POST "])').first().click();
  await page.locator('.insp [role="tablist"] button', { hasText: 'Response' }).click();
  await page.locator('.insp .ibar button', { hasText: 'Raw' }).click();
  await page.focus('.rawsse');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const raw = await page.evaluate(() => {
    const el = document.activeElement!;
    const s = getComputedStyle(el);
    return { raw: el.classList.contains('rawsse'), style: s.outlineStyle, offset: s.outlineOffset };
  });
  expect(raw).toEqual({ raw: true, style: 'solid', offset: '-2px' });
});

test('Search or jump to is a combobox, and hands the focus back when Esc closes it', async ({ page }) => {
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  await page.focus('header.top button.sbtn');
  await page.keyboard.press('Enter');
  const field = page.locator('.palin input');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('role', 'combobox');
  const active = async () => page.evaluate(() => {
    const id = document.querySelector('.palin input')!.getAttribute('aria-activedescendant');
    const el = id ? document.getElementById(id) : null;
    return el ? { id, role: el.getAttribute('role'), selected: el.getAttribute('aria-selected'), text: el.textContent } : null;
  });
  const first = (await active())!;
  expect(first).toMatchObject({ role: 'option', selected: 'true' });
  await page.keyboard.press('ArrowDown');
  const second = (await active())!;
  expect(second.id).not.toBe(first.id);
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.palette')).toHaveCount(0);
  expect(await focusedLabel(page)).toContain('Search or jump to');
});

test('a menu closes on Esc to its button; a dialog keeps Tab in it and hands the focus back', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const share = page.locator('.rhead .actions button', { hasText: 'Share' });
  await share.click();
  await expect(page.locator('.pop[role="menu"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pop[role="menu"]')).toHaveCount(0);
  await expect(share).toBeFocused();
  // Delete run waits in …, which the dialog hands the focus back to.
  const del = page.locator('#moreBtn');
  await del.click();
  await page.locator('.pop[role="menu"] [role="menuitem"]', { hasText: 'Delete run' }).click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(del).toBeFocused();
});

test('on a phone, a menu’s sheet closes on Esc to its button, a dialog’s sheet keeps Tab in it and hands the focus back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const share = page.locator('.rhead .actions button', { hasText: 'Share' });
  await share.click();
  const sheet = page.locator('.pop.sheet[role="menu"]');
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(share).toBeFocused();
  // Delete run waits in …, which the dialog hands the focus back to.
  const del = page.locator('#moreBtn');
  await del.click();
  await page.locator('.pop[role="menu"] [role="menuitem"]', { hasText: 'Delete run' }).click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(del).toBeFocused();
});

test('on a phone, the sidebar hands the focus back to the menu button when Esc closes it', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  const menu = page.locator('button.menu-toggle');
  await menu.click();
  await expect(page.locator('aside#side.open')).toBeVisible();
  await page.focus('aside#side .navlist a');
  await page.keyboard.press('Escape');
  await expect(page.locator('aside#side.open')).toHaveCount(0);
  await expect(menu).toBeFocused();
});

test('every link the server writes opens a page the dashboard has', async ({ request }) => {
  const links = await serverLinks(request);
  expect(links.size).toBeGreaterThan(20);
  for (const link of links) {
    const route = parseRoute(link);
    expect(route.page, link).not.toBe('notfound');
    // A link to Runs with a filter opens that filter, and every link reads back as it was written.
    if (link.includes('?')) expect(runsLinkQuery(link), link).not.toBeNull();
    expect(routeHref(route), link).toBe(link);
  }
});

test('a preview’s link opens Preview and a migration’s Changes on Verdicts, and neither Preview, Verdicts nor a revision’s page scrolls sideways on a phone', async ({ page, request }) => {
  const { origin, token } = dash();
  const get = async (path: string) => (await request.get(`${origin}/api/${path}`, { headers: { 'x-shadowlap-token': token } })).json();
  const { sessions } = (await get('decisions')) as { sessions: Array<{ kind: 'decisions' | 'migrate'; href: string }> };
  const preview = sessions.find((s) => s.kind === 'decisions')?.href;
  expect(preview, 'the demo’s preview').toMatch(/^#\/changes\/decisions\//);
  await openPage(page, preview!.slice(1), 'main#view .dmx button.dc');
  expect(await page.evaluate(() => location.hash)).toBe(preview);
  await expect(page.locator('main#view a[aria-current="page"]', { hasText: 'Preview' })).toHaveCount(1);
  // At a desk the matrix's key is a line; the matrix is the container its narrow rules ask of (`matrix`).
  const key = page.locator('main#view .dmx .mxkey');
  expect(await key.evaluate((k) => [getComputedStyle(k).display, getComputedStyle(k.closest('.dmx')!).containerName])).toEqual(['block', 'matrix']);
  const migration = sessions.find((s) => s.kind === 'migrate')?.href;
  expect(migration, 'the demo’s migration').toMatch(/^#\/changes\/migrate\//);
  await openPage(page, migration!.slice(1), 'main#view table.vdt tbody tr');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/changes');
  const { lead } = (await get('verdicts')) as { lead: { key: string } | null };
  expect(lead, 'the demo’s newest revision a session ran every golden at').not.toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, '/changes', 'main#view table.vdt tbody tr');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  // A key can hold a `+`, which the token link stops at: the page goes there from Verdicts.
  await page.evaluate((key) => {
    location.hash = `#/changes/verdicts/${encodeURIComponent(key)}`;
  }, lead!.key);
  await page.waitForSelector('main#view table.vdg tbody tr', { state: 'visible' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  // Preview's matrix scrolls a row's cells in their own box, never the page; its key turns into two aligned columns.
  await openPage(page, preview!.slice(1), 'main#view .dmx button.dc');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(await key.evaluate((k) => [getComputedStyle(k).display, getComputedStyle(k).gridTemplateColumns.split(' ').length])).toEqual(['grid', 2]);
});

test.describe('a preview on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('keeps a long row’s cells 18 px with room to tap each, the row scrolling in its own box, with no serious axe violation', async ({ page, request }) => {
    const { origin, token } = dash();
    const { sessions } = (await (await request.get(`${origin}/api/decisions`, { headers: { 'x-shadowlap-token': token } })).json()) as { sessions: Array<{ kind: string; sessionId: string; href: string }> };
    const s = sessions.find((x) => x.kind === 'decisions');
    expect(s, 'the demo’s preview').toBeTruthy();
    // A run of 30 model calls, its first row's cells over again: more than a phone's row holds at 18 px.
    await page.route(`**/api/decisions/${s!.sessionId}`, async (route) => {
      const body = (await (await route.fetch()).json()) as { matrix: Array<{ cells: Array<Record<string, unknown>> }> };
      const row = body.matrix[0]!;
      row.cells = Array.from({ length: 30 }, (_, i) => ({ ...row.cells[i % row.cells.length], callNo: i + 1, step: i + 1 }));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await openPage(page, s!.href.slice(1), 'main#view .dmx button.dc');
    const cells = page.locator('main#view .dmr').first().locator('button.dc');
    await expect(cells).toHaveCount(30);
    const sizes = await cells.evaluateAll((bs) => [...new Set(bs.map((b) => `${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`))]);
    expect(sizes).toEqual(['18x22']);
    // 6 px apart, so each takes 24 px of taps across its step.
    expect(await cells.evaluateAll((bs) => Math.round(bs[1]!.getBoundingClientRect().left - bs[0]!.getBoundingClientRect().right))).toBe(6);
    const box = page.locator('main#view .dmr').first().locator('.dmcw');
    expect(await box.evaluate((b) => b.scrollWidth > b.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test('Runs keeps its filters in the address, Back goes back through them, and it has no serious axe violation', async ({ page }) => {
  await openPage(page, '/runs?types=recording&sort=calls', 'main#view table.runst tbody tr');
  const pressed = () => page.locator('main#view .tbar .chips button[aria-pressed="true"]');
  await expect(pressed()).toHaveCount(1);
  expect(await pressed().evaluate((b) => b.childNodes[0]?.textContent)).toBe('Recordings');
  await expect(page.locator('main#view th[aria-sort="descending"]')).toContainText('Calls');
  expect(await seriousViolations(page)).toEqual([]);
  // A chip is a step of its own: Back is the view before it.
  await page.locator('main#view .tbar .chips button', { hasText: /^All/ }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/runs?sort=calls');
  await page.goBack();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/runs?types=recording&sort=calls');
  expect(await pressed().evaluate((b) => b.childNodes[0]?.textContent)).toBe('Recordings');
  // The filter checks no spelling, and says how many runs its words match; Esc leaves it with its words kept, the
  // search field's own clear never taking them.
  const field = page.locator('main#view #runsQuery');
  await expect(field).toHaveAttribute('spellcheck', 'false');
  await expect(field).toHaveAttribute('placeholder', 'Filter: words, label:, status:, type: or tool:');
  await field.fill('type:recording');
  await expect(page.locator('main#view .rqw .qn[role="status"]')).toHaveText(/^\d[\d,]* runs? match(es)?$/);
  await page.keyboard.press('Escape');
  await expect(field).not.toBeFocused();
  await expect(field).toHaveValue('type:recording');
});

test('the good/bad key labels a run in one press, says so with Undo, and has no serious axe violation', async ({ page }) => {
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const good = page.locator('.rhead .runkey button', { hasText: 'good' });
  await expect(good).toHaveAttribute('aria-pressed', 'false');
  await good.click();
  await expect(good).toHaveAttribute('aria-pressed', 'true');
  const undo = page.locator('.toast button', { hasText: 'Undo' });
  await expect(undo).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await undo.click();
  await expect(good).toHaveAttribute('aria-pressed', 'false');
  // On Runs, each row has the key, its buttons named for a screen reader.
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  const key = page.locator('main#view table.runst tbody tr').first().locator('td.keycell .runkey');
  await expect(key.locator('button')).toHaveCount(2);
  expect(await seriousViolations(page)).toEqual([]);
});

test('a run’s trace: a model call’s caret, a sub-agent’s row, the fold buttons one Tab stop, with no serious axe violation', async ({ page }) => {
  await openPage(page, `/run/${demoId('eval')}`, 'run');
  await page.waitForSelector('main#view table.calls.grouped button.tcaret');
  const caret = page.locator('main#view table.calls button.tcaret').first();
  await expect(caret).toHaveAttribute('aria-expanded', 'true');
  await expect(caret).toHaveAttribute('aria-label', /^Hide (tool )?calls? of #\d+$/);
  // The eval's policy checker runs under the agent: a row of its own names it.
  await expect(page.locator('main#view table.calls tr.tgr button.tgsum').filter({ hasText: 'policy-checker' }).first()).toHaveAttribute('aria-label', /^policy-checker, sub-agent, \d+ calls?/);
  const rows = await page.locator('main#view table.calls tbody tr[data-wi]').count();
  // The stop starts in the selected call's group. A press focuses the caret and redraws nothing
  // until its click, so nothing moves the caret from under the pointer; the click folds and makes it the stop.
  await expect(caret).toHaveAttribute('tabindex', '-1');
  await caret.hover();
  await page.mouse.down();
  await expect(caret).toBeFocused();
  await expect(caret).toHaveAttribute('tabindex', '-1');
  await page.mouse.up();
  await expect(caret).toHaveAttribute('aria-expanded', 'false');
  await expect(caret).toHaveAttribute('tabindex', '0');
  expect(await page.locator('main#view table.calls tbody tr[data-wi]').count()).toBeLessThan(rows);
  expect(await page.locator('main#view table.calls [data-fold][tabindex="0"]').count()).toBe(1);
  expect(await seriousViolations(page)).toEqual([]);
  // Opened again at its own caret: there is no Fold all or Unfold all.
  await caret.click();
  await expect(caret).toHaveAttribute('aria-expanded', 'true');
  expect(await page.locator('main#view').getByRole('button', { name: /^(Un)?[Ff]old all$/ }).count()).toBe(0);
});

test('a batch’s tickets are rows of their own, each named by what it was asked, the fourth folded until opened', async ({ page }) => {
  await openPage(page, `/run/${demoId('batch')}`, 'run');
  await page.waitForSelector('main#view table.calls tr.tgr button.tgsum');
  const items = page.locator('main#view table.calls tr.tgr button.tgsum');
  await expect(items.first()).toHaveAttribute('aria-label', /^New ticket T-9100 /);
  // The first three are open; folded, each brings the next into view, and the fourth is folded.
  for (const n of [0, 1, 2]) {
    await expect(items.nth(n)).toHaveAttribute('aria-expanded', 'true');
    await items.nth(n).click();
    await expect(items.nth(n)).toHaveAttribute('aria-expanded', 'false');
  }
  await expect(items.nth(3)).toHaveAttribute('aria-expanded', 'false');
  // ↓ on a focused fold button moves to the next, and → opens a folded one.
  await items.nth(2).focus();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(3)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(items.nth(3)).toHaveAttribute('aria-expanded', 'true');
  expect(await seriousViolations(page)).toEqual([]);
});

/** Until every page of a long run is read: the line that says how many are read is gone. */
async function everyPageRead(page: Page): Promise<void> {
  await expect(page.locator('main#view .toolbar[role="status"]')).toHaveCount(0, { timeout: 60_000 });
}

test.describe('on a tall window', () => {
  // A ticket's thirty calls and the row after them drawn at once.
  test.use({ viewport: { width: 1280, height: 2000 } });

  test('j from a ticket’s last call opens the next ticket, and Home and End on a fold button reach the first ticket and the last', async ({ page }) => {
    await openPage(page, `/run/${demoId('batch')}`, 'run');
    await everyPageRead(page);
    const items = page.locator('main#view table.calls tr.tgr button.tgsum');
    // The first two folded, the third's last call sits right above the fourth's row.
    for (const n of [0, 1]) {
      await items.nth(n).click();
      await expect(items.nth(n)).toHaveAttribute('aria-expanded', 'false');
    }
    const next = page.locator('main#view table.calls tbody tr[data-call] + tr.tgr');
    await expect(next).toHaveCount(1);
    const fourth = page.locator(`main#view table.calls tbody tr.tgr[data-fold="${(await next.getAttribute('data-fold')) ?? ''}"] button.tgsum`);
    await expect(fourth).toHaveAttribute('aria-expanded', 'false');
    const last = next.locator('xpath=preceding-sibling::tr[1]');
    const n = Number(await last.getAttribute('data-call'));
    expect(n).toBeGreaterThan(0);
    await last.click();
    await page.keyboard.press('j');
    await expect(page.locator('main#view table.calls tbody tr[aria-selected="true"]')).toHaveAttribute('data-call', String(n + 1));
    await expect(fourth).toHaveAttribute('aria-expanded', 'true');
    await fourth.focus();
    await page.keyboard.press('End');
    await expect.poll(() => focusedLabel(page)).toMatch(/^button\.tgsum “New ticket T-9139 /);
    await page.keyboard.press('Home');
    await expect.poll(() => focusedLabel(page)).toMatch(/^button\.tgsum “New ticket T-9100 /);
    expect(await page.locator('main#view table.calls [data-fold][tabindex="0"]').count()).toBe(1);
  });
});

test('a batch fork’s ticket folded around the fork holds the selection, with the fork’s mark in its # cell', async ({ page }) => {
  await openPage(page, `/run/${demoId('batchFork')}/906`, 'run');
  await everyPageRead(page);
  const fork = page.locator('main#view table.calls tbody tr[data-call="906"]');
  await expect(fork).toHaveAttribute('aria-selected', 'true');
  // Ticket 31's row, the nearest group row above the fork.
  const key = await fork.locator('xpath=preceding-sibling::tr[contains(concat(" ", @class, " "), " tgr ")][1]').getAttribute('data-fold');
  const ticket = page.locator(`main#view table.calls tbody tr.tgr[data-fold="${key ?? ''}"]`);
  await expect(ticket.locator('button.tgsum')).toHaveAttribute('aria-label', /^New ticket T-9130 /);
  await expect(ticket.locator('td.n .fk')).toHaveCount(0);
  await ticket.locator('button.tgsum').click();
  await expect(ticket.locator('button.tgsum')).toHaveAttribute('aria-expanded', 'false');
  await expect(ticket).toHaveClass('tgr held');
  await expect(ticket.locator('td.n .fk')).toHaveText('fork');
  // The selection stays on the fork: the address names it, and no call row is selected in its place.
  expect(new URL(page.url()).hash).toMatch(/\/906$/);
  await expect(page.locator('main#view table.calls tbody tr[aria-selected="true"]')).toHaveCount(0);
  expect(await seriousViolations(page)).toEqual([]);
});

test('what a run did that Shadowlap did not record is among its findings, with no serious axe violation', async ({ page }) => {
  // The eval's agent hands the policy check to a function it never wrapped: the model called it, and nothing recorded it.
  await openPage(page, `/run/${demoId('eval')}`, 'run');
  await openFindings(page);
  await page.waitForSelector('main#view .findings .rnote');
  await expect(page.locator('main#view .findings .rntools code').first()).toHaveText('check_policy');
  expect(await seriousViolations(page)).toEqual([]);
});

test('on a phone, what a run did that Shadowlap did not record wraps inside the page, its hint a sentence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, `/run/${demoId('eval')}`, 'run');
  await openFindings(page);
  await page.waitForSelector('main#view .findings .rnhint');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  const past = await page.evaluate(() => [...document.querySelectorAll('main#view .findings *')].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((el) => el.className));
  expect(past).toEqual([]);
  // No line of the hint starts with its own punctuation: ". Or declare…" follows the code before it.
  const lineStart = await page.evaluate(() => {
    const hint = document.querySelector('main#view .rnhint')!;
    const walker = document.createTreeWalker(hint, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.startsWith('. Or')) continue;
      const r = document.createRange();
      r.setStart(n, 0);
      r.setEnd(n, 1);
      return r.getBoundingClientRect().left - hint.getBoundingClientRect().left;
    }
    return null;
  });
  expect(lineStart).not.toBeNull();
  expect(lineStart!).toBeGreaterThan(2);
});

test('the Request tab’s fold marks are 24 px tall at least, as WCAG 2.5.8 asks of a target', async ({ page }) => {
  await openPage(page, `/run/${demoId('override')}`, 'run');
  await page.locator('.insp [role="tablist"] button', { hasText: 'Request' }).click();
  await page.waitForSelector('.ibody details > summary');
  const heights = await page.locator('.ibody details > summary').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(24);
});
