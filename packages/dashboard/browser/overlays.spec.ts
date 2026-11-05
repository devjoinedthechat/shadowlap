import { expect, test, type Locator, type Page } from '@playwright/test';
import { demoId, focusedLabel, openPage, seriousViolations } from './dashboard.js';

/**
 * Every overlay on one set of rules, in Chromium over the demo store: a menu placed by the room there
 * is, with its keys, its rows and its widths; a picker's filter; a modal that fits, the app behind it
 * out of reach, and the ask before it discards an edit; hover cards for the pointer, the keyboard and
 * a finger; and on a phone, 390 px wide, each of them a sheet from the foot of the screen.
 */

const MENU = '.pop[role="menu"]';
const DIALOG = '[role="dialog"][aria-modal="true"]';
const shareButton = (page: Page) => page.locator('.rhead .actions button', { hasText: 'Share' });
const box = async (l: Locator) => (await l.boundingBox())!;
/** Add redaction rule's field a person fills first: it holds its own default, so a change is an edit. */
const replaceWith = (dialog: Locator) => dialog.locator('label', { hasText: 'Replace with' }).locator('input');

test('a menu sits under its button at the edge nearer the window’s middle, or over it where there is more room, never over the button', async ({ page }) => {
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const share = shareButton(page);
  await share.click();
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  const [b, m] = [await box(share), await box(menu)];
  expect(m.y).toBe(b.y + b.height + 6);
  // A button right of the window's middle: the menu's right edge under the button's.
  expect(m.x + m.width).toBeCloseTo(b.x + b.width, 0);
  await page.keyboard.press('Escape');
  // A window too low for it: over the button where there is more room, else scrolling, 12px from the window's edges.
  await page.setViewportSize({ width: 1440, height: 340 });
  await share.click();
  const low = await box(menu);
  expect(low.y).toBeGreaterThanOrEqual(12);
  expect(low.y + low.height).toBeLessThanOrEqual(340 - 12);
  const button = await box(share);
  expect(low.y >= button.y + button.height || low.y + low.height <= button.y).toBe(true);
});

test('a menu keeps its keys: ↓ opens it, a letter finds an item, Home and End jump, Tab closes it and goes on from its button', async ({ page }) => {
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const share = shareButton(page);
  await share.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(MENU)).toBeVisible();
  const item = () => page.evaluate(() => { const el = document.activeElement!; return (el.querySelector('b') ?? el).textContent ?? ''; });
  const first = await item();
  await page.keyboard.press('e');
  expect(await item()).toBe('Eval dataset…');
  // Its last item is the way to the rules, in the line under the copies.
  await page.keyboard.press('End');
  expect(await item()).toBe('Settings');
  await page.keyboard.press('ArrowDown');
  expect(await item()).toBe(first);
  await page.keyboard.press('ArrowUp');
  expect(await item()).toBe('Settings');
  await page.keyboard.press('ArrowUp');
  expect(await item()).toBe('HAR file');
  await page.keyboard.press('Home');
  expect(await item()).toBe(first);
  // No key reaches the page behind it: ? opens no shortcuts, j moves no call.
  const selected = () => page.locator('main#view table.calls tr[aria-selected="true"]').getAttribute('data-wi');
  const before = await selected();
  await page.keyboard.press('j');
  await page.keyboard.press('?');
  expect(await selected()).toBe(before);
  await expect(page.locator('.help')).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(page.locator(MENU)).toHaveCount(0);
  // Past the button, in the page.
  expect(await page.evaluate(() => document.activeElement?.closest('.rhead .actions') !== null)).toBe(true);
  expect(await focusedLabel(page)).not.toContain('Share');
  // ↑ opens it on its last item, and ⌘K goes on to the palette from it.
  await share.focus();
  await page.keyboard.press('ArrowUp');
  expect(await item()).toBe('Settings');
  await page.keyboard.press('Meta+k');
  await expect(page.locator('.palette')).toBeVisible();
  await expect(page.locator(MENU)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(share).toBeFocused();
});

test('a menu’s rows are 34 to 36px, one line each, and it is 340 or 280px wide', async ({ page }) => {
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  await page.locator('#forkBtn').click();
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  expect((await box(menu)).width).toBe(340);
  const rows = await menu.locator('[role="menuitem"]').evaluateAll((els) => els.map((el) => ({ h: el.getBoundingClientRect().height, left: el.querySelector('b')!.getBoundingClientRect().top, right: el.querySelector('small')!.getBoundingClientRect().top })));
  expect(rows.length).toBeGreaterThan(3);
  for (const r of rows) {
    expect(r.h).toBeGreaterThanOrEqual(34);
    expect(r.h).toBeLessThanOrEqual(36);
    expect(Math.abs(r.left - r.right)).toBeLessThan(6);
  }
  await page.keyboard.press('Escape');
  await page.locator('button.proj').click();
  expect((await box(menu)).width).toBe(280);
});

test('the project switcher checks the current project, and → reaches a row’s ×', async ({ page }) => {
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  await page.locator('button.proj').click();
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  const row = menu.locator('[role="menuitemradio"]').first();
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-checked', 'true');
  const mark = await row.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(mark).toBe('"✓"');
  if ((await menu.locator('.px').count()) > 0) {
    await page.keyboard.press('ArrowRight');
    await expect(menu.locator('.px').first()).toBeFocused();
    expect(await menu.locator('.px').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await page.keyboard.press('ArrowLeft');
    await expect(row).toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('button.proj')).toBeFocused();
});

test('a click outside a menu closes it: the focus stays on a control it landed on, and comes back from where nothing takes it', async ({ page }) => {
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const share = shareButton(page);
  await share.click();
  // The top bar's blank space: nothing there takes the focus.
  await page.locator('header.top').click({ position: { x: 700, y: 26 } });
  await expect(page.locator(MENU)).toHaveCount(0);
  await expect(share).toBeFocused();
  await share.click();
  await expect(page.locator(MENU)).toBeVisible();
  const filter = page.locator('main#view input[placeholder="Filter calls"]');
  await filter.click();
  await expect(page.locator(MENU)).toHaveCount(0);
  await expect(filter).toBeFocused();
  // A second click on its button closes it.
  await share.click();
  await expect(page.locator(MENU)).toBeVisible();
  await share.click();
  await expect(page.locator(MENU)).toHaveCount(0);
});

test('a picker is a combobox with a filter: it finds a run by its id or about line, says when nothing matches, and hands the focus back', async ({ page }) => {
  await openPage(page, '/compare', 'main#view .pickers .rpick');
  const button = page.locator('.rpick').first();
  await button.click();
  const field = page.locator('.pop.picker input.pfilter');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('role', 'combobox');
  // At its button's width, in its button's type, the one picked checked.
  expect((await box(page.locator('.pop.picker'))).width).toBe((await box(button)).width);
  const active = () => page.evaluate(() => {
    const id = document.querySelector('input.pfilter')!.getAttribute('aria-activedescendant');
    return id ? document.getElementById(id)?.textContent ?? null : null;
  });
  const options = page.locator('.pop.picker [role="option"]');
  const count = await options.count();
  expect(count).toBeGreaterThan(3);
  await expect(page.locator('.pop.picker [role="option"][aria-selected="true"]')).toHaveCount(1);
  expect(await page.locator('.pop.picker [role="option"][aria-selected="true"]').evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"✓"');
  const start = await active();
  await page.keyboard.press('ArrowUp');
  expect(await active()).not.toBe(start);
  await expect(field).toBeFocused();
  await page.keyboard.press('Home');
  const top = await active();
  await page.keyboard.press('End');
  expect(await active()).not.toBe(top);
  await page.keyboard.press('PageUp');
  await field.fill('zzzz nothing like it');
  await expect(page.locator('.pop.picker .pnone')).toHaveText('Nothing matches.');
  await expect(page.locator('.pop.picker [role="listbox"]')).toHaveCount(0);
  expect(await seriousViolations(page)).toEqual([]);
  await field.fill('');
  await expect(options).toHaveCount(count);
  expect(await seriousViolations(page)).toEqual([]);
  // A run by the words of its about line.
  const about = await options.nth(1).locator('.rab').getAttribute('data-about');
  await field.fill(about!.split(' ').slice(0, 2).join(' '));
  expect(await options.count()).toBeGreaterThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pop.picker')).toHaveCount(0);
  await expect(button).toBeFocused();
  // Picked, the address follows and the picker keeps the focus.
  await button.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.locator('.pop.picker')).toHaveCount(0);
  await expect(page.locator('.rpick').first()).toBeFocused();
});

test('a modal fits the window: its header and footer stay in view, its body scrolls, and the app behind is out of reach', async ({ page }) => {
  await openPage(page, '/runs', 'main#view table.runst tbody tr');
  await page.locator('main#view button', { hasText: 'Import capture' }).first().click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  // It sits beside the app, which can't be reached, nor the job's dock, nor the connection bar's place.
  expect(await dialog.evaluate((el) => el.closest('#layer') !== null)).toBe(true);
  for (const sel of ['#app', '#conn', '#dock', 'a.skip']) expect(await page.locator(sel).getAttribute('inert'), sel).toBe('');
  // Import capture starts on its drop zone.
  await expect(page.locator('.dialog .drop')).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 320 });
  const d = await box(dialog);
  expect(d.y).toBeGreaterThanOrEqual(16);
  expect(d.y + d.height).toBeLessThanOrEqual(320 - 16);
  const cancel = await box(page.locator('.dialog .dlg-cancel'));
  expect(cancel.y + cancel.height).toBeLessThanOrEqual(320);
  const body = page.locator('.dialog > .db');
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  for (const sel of ['#app', '#conn', '#dock', 'a.skip']) expect(await page.locator(sel).getAttribute('inert'), sel).toBeNull();
});

test('a modal’s scrim closes it only on a press that starts and ends on it', async ({ page }) => {
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const del = page.locator('.rhead .actions button', { hasText: 'Delete' });
  await del.click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  // Red, so it starts on Cancel: a second Enter never deletes.
  await expect(page.locator('.dialog .dlg-cancel')).toBeFocused();
  const d = await box(dialog);
  // A selection dragged out of the dialog onto the scrim.
  await page.mouse.move(d.x + 40, d.y + 20);
  await page.mouse.down();
  await page.mouse.move(40, 40);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  // A press on the scrim that ends in the dialog.
  await page.mouse.move(40, 40);
  await page.mouse.down();
  await page.mouse.move(d.x + 40, d.y + 20);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  // A press on the scrim.
  await page.mouse.click(40, 40);
  await expect(dialog).toHaveCount(0);
  await expect(del).toBeFocused();
});

test('Esc or the scrim on a dialog with edits asks first, and Cancel never does', async ({ page }) => {
  await openPage(page, '/settings/redaction', 'main#view .pvhead');
  const add = page.locator('main#view button', { hasText: 'Add redaction rule' }).first();
  await add.click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  // Nothing changed: Esc closes it at once, the focus back on what opened it.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  const path = replaceWith(dialog);
  await path.fill('<GONE>');
  await page.keyboard.press('Escape');
  await expect(dialog.locator('.dlgask')).toHaveText('Discard what you changed?');
  await expect(dialog.locator('.dlg-keep')).toBeFocused();
  await expect(dialog.locator('.dlg-cancel')).toBeHidden();
  expect(await seriousViolations(page)).toEqual([]);
  // A second Esc keeps editing, with what was typed and the focus where it was.
  await page.keyboard.press('Escape');
  await expect(dialog.locator('.dlgask')).toHaveCount(0);
  await expect(path).toBeFocused();
  await expect(path).toHaveValue('<GONE>');
  await page.mouse.click(40, 40);
  await expect(dialog.locator('.dlgask')).toBeVisible();
  await dialog.locator('header').click();
  await expect(dialog.locator('.dlgask')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await dialog.locator('.dlg-discard').click();
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  await path.fill('<OTHER>');
  await dialog.locator('.dlg-cancel').click();
  await expect(dialog).toHaveCount(0);
});

test('a hover card waits 400 ms for a pointer, shows at once for the keyboard, and its element points at it', async ({ page }) => {
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const tip = page.locator('#tip');
  const cell = page.locator('.cells button').nth(2);
  await cell.hover();
  await expect(tip).toBeHidden();
  await page.waitForTimeout(150);
  await expect(tip).toBeHidden();
  await expect(tip).toBeVisible();
  await expect(cell).toHaveAttribute('aria-describedby', 'tip');
  // Anchored to its element, not to the pointer: under it, at its left edge unless the window's edge says otherwise.
  const [c, t] = [await box(cell), await box(tip)];
  expect(t.y).toBeGreaterThanOrEqual(c.y + c.height);
  // Figures as the CLI prints them.
  expect(await tip.evaluate((el) => getComputedStyle(el).fontVariantLigatures)).toBe('none');
  // The next one shows at once while one was showing.
  const next = page.locator('.cells button').nth(4);
  await next.hover();
  await expect(next).toHaveAttribute('aria-describedby', 'tip', { timeout: 300 });
  expect(await cell.getAttribute('aria-describedby')).toBeNull();
  expect(await seriousViolations(page)).toEqual([]);
  await page.mouse.move(2, 2);
  await expect(tip).toBeHidden();
  // A link in a line of its own has the card of the line, and points at it.
  const link = page.locator('main#view .metric .st[data-tip] a').first();
  await link.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  await expect(tip).toBeVisible();
  await expect(link).toHaveAttribute('aria-describedby', /tip/);
  await page.keyboard.press('Shift+Tab');
  await expect(tip).toBeHidden();
  await expect(link).not.toHaveAttribute('aria-describedby', /tip/);
  // A fact has no action of its own, so it takes the focus: Tab shows its card at once.
  await openPage(page, `/run/${demoId('override')}`, 'run');
  const fact = page.locator('main#view .metric .st[data-tip]').first();
  await expect(fact).toHaveAttribute('tabindex', '0');
  await fact.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(fact).toBeFocused();
  await expect(tip).toBeVisible();
  await expect(fact).toHaveAttribute('aria-describedby', /tip/);
  await page.keyboard.press('Tab');
  await expect(fact).not.toHaveAttribute('aria-describedby', /tip/);
});

test('a hover card keeps clear of what it belongs to: never the menu its button opened, beside a menu row, Esc hiding it with the menu', async ({ page }) => {
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  const tip = page.locator('#tip');
  const share = shareButton(page);
  await share.click();
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  await share.hover();
  await page.waitForTimeout(500);
  await expect(tip).toBeHidden();
  await menu.locator('[role="menuitem"]').nth(1).hover();
  await expect(tip).toBeVisible();
  const [m, t] = [await box(menu), await box(tip)];
  expect(t.x + t.width <= m.x || t.x >= m.x + m.width).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(tip).toBeHidden();
});

test('forced colours keep each overlay’s edge, which is a shadow they drop', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openPage(page, `/run/${demoId('ticket')}`, 'run');
  await shareButton(page).click();
  const outline = (sel: string) => page.locator(sel).evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(await outline(MENU)).toBe('solid');
  await page.keyboard.press('Escape');
  await page.locator('.rhead .actions button', { hasText: 'Delete' }).click();
  expect(await outline('.dialog')).toBe('solid');
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  expect(await outline('.help')).toBe('solid');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+k');
  expect(await outline('.palette')).toBe('solid');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a menu is a sheet from the foot of the screen, 44px rows over a scrim that takes the tap that closes it', async ({ page }) => {
    await openPage(page, `/run/${demoId('ticket')}`, 'run');
    const share = shareButton(page);
    await share.click();
    const sheet = page.locator(`${MENU}.sheet`);
    await expect(sheet).toBeVisible();
    const s = await box(sheet);
    expect([s.x, s.width, s.y + s.height]).toEqual([0, 390, 844]);
    const heights = await sheet.locator('button[role="menuitem"]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    expect(await seriousViolations(page)).toEqual([]);
    // The tap lands on the scrim, not on the page under it.
    const hash = await page.evaluate(() => location.hash);
    await page.mouse.click(195, 60);
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.msheet')).toHaveCount(0);
    await expect(share).toBeFocused();
    expect(await page.evaluate(() => location.hash)).toBe(hash);
  });

  test('a picker is a sheet with 44px rows and a 44px filter', async ({ page }) => {
    await openPage(page, '/compare', 'main#view .pickers .rpick');
    await page.locator('.rpick').first().click();
    const sheet = page.locator('.pop.picker.sheet');
    await expect(sheet).toBeVisible();
    const s = await box(sheet);
    expect([s.x, s.width, s.y + s.height]).toEqual([0, 390, 844]);
    expect((await box(sheet.locator('input.pfilter'))).height).toBe(44);
    const heights = await sheet.locator('[role="option"]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('a dialog is a sheet, full width and rounded at the top, its buttons and fields 44px, Cancel first', async ({ page }) => {
    await openPage(page, '/settings/redaction', 'main#view .pvhead');
    await page.locator('main#view button', { hasText: 'Add redaction rule' }).first().click();
    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    const d = await box(dialog);
    expect([d.x, d.width, d.y + d.height]).toEqual([0, 390, 844]);
    expect(await dialog.evaluate((el) => { const s = getComputedStyle(el); return [s.borderTopLeftRadius, s.borderBottomLeftRadius]; })).toEqual(['14px', '0px']);
    const [cancel, ok] = [await box(dialog.locator('.dlg-cancel')), await box(dialog.locator('.dlg-ok'))];
    expect(cancel.height).toBe(44);
    expect(ok.height).toBe(44);
    expect(cancel.x).toBeLessThan(ok.x);
    expect((await box(replaceWith(dialog))).height).toBe(44);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('the shortcuts are a sheet, and the palette stays centred, its opener in the closed sidebar handing the focus to the sidebar’s button', async ({ page }) => {
    await openPage(page, '/runs', 'main#view table.runst tbody tr');
    await page.keyboard.press('?');
    const help = page.locator('.help');
    await expect(help).toBeVisible();
    const h = await box(help);
    expect([h.x, h.width, h.y + h.height]).toEqual([0, 390, 844]);
    await page.keyboard.press('Escape');
    await page.locator('button.menu-toggle').click();
    await expect(page.locator('aside#side.open')).toBeVisible();
    await page.locator('aside#side button.sbtn').click();
    const palette = page.locator('.palette');
    await expect(palette).toBeVisible();
    // The sidebar closes behind it.
    await expect(page.locator('aside#side.open')).toHaveCount(0);
    const p = await box(palette);
    expect(p.x).toBe(16);
    expect(p.y).toBeGreaterThan(16);
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('button.menu-toggle')).toBeFocused();
  });
});

test.describe('with a finger', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a picker opens on its list so the phone’s keyboard stays closed, and a dialog skips its field', async ({ page }) => {
    await openPage(page, '/compare', 'main#view .pickers .rpick');
    await page.locator('.rpick').first().tap();
    await expect(page.locator('.pop.picker.sheet')).toBeVisible();
    await expect(page.locator('.pop.picker .pklist')).toBeFocused();
    await page.mouse.click(195, 8);
    await expect(page.locator('.pop.picker')).toHaveCount(0);
    await openPage(page, '/settings/redaction', 'main#view .pvhead');
    await page.locator('main#view button', { hasText: 'Add redaction rule' }).first().tap();
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator('.dialog .dlg-ok')).toBeFocused();
  });

  test('a tap toggles a fact’s hover card', async ({ page }) => {
    const tip = page.locator('#tip');
    await openPage(page, `/run/${demoId('override')}`, 'run');
    const fact = page.locator('main#view .metric .st[data-tip]').first();
    await fact.tap();
    await expect(tip).toBeVisible();
    await fact.tap();
    await expect(tip).toBeHidden();
  });
});
