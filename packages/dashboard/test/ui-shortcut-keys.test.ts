import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GO_KEYS } from '../ui/route.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { Shortcuts } from '../ui/shell/Shortcuts.js';
import { goKeyColumn, keyColumn, pressShortcut, setSingleKeys, sheetLines, shortcut, singleKeysOn, switchSentence, useSingleKeys, type SheetPlace } from '../ui/shortcuts.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The single-key shortcuts (? for the shortcuts, / for the palette, g then a letter, u for a toast's
 * Undo) keep out of what is typed in a field, and only that: a checkbox, which Runs ticks a run with,
 * takes no key a shortcut uses, so ? opens the shortcuts with the focus on it. Rendered with the
 * shell's own key handler.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  setSingleKeys(true);
  vi.unstubAllGlobals();
});

const place = (over: Partial<SheetPlace> = {}): SheetPlace => ({ exported: false, onRun: false, onRuns: false, compares: false, ...over });
const words = (group: Parameters<typeof sheetLines>[0], over: Partial<SheetPlace> = {}, mac = true) => sheetLines(group, place(over), mac).map((l) => l.label);

function hand(over: Partial<AppState> = {}): AppState {
  return { conn: 'ok', exported: false, meta: null, palette: false, setPalette: () => undefined, help: false, setHelp: () => undefined, sideOpen: false, setSideOpen: () => undefined, runKeys: { current: null }, ...over } as unknown as AppState;
}

describe('the table of keys', () => {
  it('draws the sheet’s groups by where it opens', () => {
    expect(words('Anywhere')).toEqual(['Search or jump to anything', 'Search or jump to anything', 'Show these shortcuts', 'Undo, while a toast offers it', 'Close menu or dialog, then go up a level']);
    expect(words('Anywhere', { onRun: true })[1]).toBe('Filter calls');
    expect(words('Anywhere', { onRuns: true })[1]).toBe('Filter runs');
    // A copy has no palette, and nothing to search away from its lists.
    expect(words('Anywhere', { exported: true })).toEqual(['Show these shortcuts', 'Undo, while a toast offers it', 'Close menu or dialog, then go up a level']);
    expect(words('In a list', { exported: true })).toEqual(['Next or previous row', 'The same, on a row in focus', 'Open row', 'Let go of the row']);
    expect(words('In a list')).toEqual(['Next or previous row', 'The same, on a row in focus', 'Open row', 'The row’s actions', 'Select row, on Runs', 'Label it good or bad, on Runs', 'Clear selection, then let go']);
    expect(words('Go to', { exported: true })).toEqual(['Runs']);
    expect(words('Go to', { exported: true, compares: true })).toEqual(['Runs', 'Compare']);
    expect(words('On a run', { exported: true, compares: true })).toContain('Compare with parent');
    expect(words('On a run')).toContain('Replay');
    expect(words('On a run', { exported: true })).not.toContain('Replay');
  });

  it('lists every g key, each with its page', () => {
    const lines = sheetLines('Go to', place(), true);
    expect(lines.map((l) => l.chips.at(-1)?.text).sort()).toEqual(Object.keys(GO_KEYS).sort());
    expect(lines.every((l) => l.single)).toBe(true);
    expect(goKeyColumn('#/runs')).toBe('g r');
    expect(goKeyColumn('#/new')).toBeUndefined();
  });

  it('says which keys the switch turns off, and writes ⌘ for the machine', () => {
    const line = (group: Parameters<typeof sheetLines>[0], label: string, mac = true) => sheetLines(group, place(), mac).find((l) => l.label === label)!;
    expect(line('Anywhere', 'Show these shortcuts').single).toBe(true);
    expect(line('Anywhere', 'Search or jump to anything').single).toBe(false);
    expect(line('Anywhere', 'Close menu or dialog, then go up a level').single).toBe(false);
    expect(line('In a list', 'The same, on a row in focus').single).toBe(false);
    expect(line('In a list', 'Open row').single).toBe(false);
    expect(line('Anywhere', 'Search or jump to anything', false).chips[0].text).toBe('Ctrl');
    expect(switchSentence(false, '⌘K')).toBe('Off, only ⌘K, Esc, Enter and the arrows work.');
    expect(switchSentence(false, 'Ctrl K')).toBe('Off, only Ctrl K, Esc, Enter and the arrows work.');
    expect(switchSentence(true, '⌘K')).toBe('Off, only Esc, Enter and the arrows work.');
  });

  it('marks a control while the switch is on, and writes a plus sign as ARIA spells it', () => {
    expect(shortcut('replay')).toEqual({ 'aria-keyshortcuts': 'r', 'data-shortcut': 'replay' });
    expect(shortcut('markGood')['aria-keyshortcuts']).toBe('Plus');
    expect(keyColumn('help')).toBe('?');
    setSingleKeys(false);
    expect(shortcut('replay')).toEqual({});
    // The palette's column reads the switch as it draws: a row built with it off has its key when it comes on.
    expect(keyColumn('help')).toBe('?');
    expect(goKeyColumn('#/runs')).toBe('g r');
    // A key with no mark marks nothing, whatever the switch says.
    setSingleKeys(true);
    expect(shortcut('up')).toEqual({});
  });

  it('remembers the switch in the browser, and works where storage throws', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) });
    setSingleKeys(false);
    expect(stored.get('shadowlap-single-keys')).toBe('off');
    vi.resetModules();
    const fresh = await import('../ui/single-keys.js');
    expect(fresh.singleKeysOn()).toBe(false);
    fresh.setSingleKeys(true);
    expect(stored.get('shadowlap-single-keys')).toBe('on');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    vi.resetModules();
    const blocked = await import('../ui/single-keys.js');
    expect(blocked.singleKeysOn()).toBe(true);
    blocked.setSingleKeys(false);
    expect(blocked.singleKeysOn()).toBe(false);
  });

  it('draws in a string, as every key on, with no storage or document', () => {
    function Read() {
      return createElement('i', {}, String(useSingleKeys()));
    }
    expect(renderToStaticMarkup(createElement(Read))).toBe('<i>true</i>');
  });

  it('presses what is on the page, says why one is off, and does nothing with none', async () => {
    const pressed = vi.fn();
    const said: string[] = [];
    const say = (w: string) => void said.push(w);
    r = await render(createElement('div', {}, createElement('button', { type: 'button', onClick: pressed, ...shortcut('replay') }, 'Replay'), createElement('button', { type: 'button', disabled: true, title: 'Fork once the recording finishes', ...shortcut('fork') }, 'Fork'), createElement('button', { type: 'button', title: 'Why not', 'aria-disabled': 'true', ...shortcut('compare') }, 'Compare')));
    expect(pressShortcut('blame', say)).toBe(false);
    expect(pressShortcut('replay', say)).toBe(true);
    expect(pressed).toHaveBeenCalledOnce();
    expect(pressShortcut('fork', say)).toBe(true);
    expect(pressShortcut('compare', say)).toBe(true);
    expect(said).toEqual(['Fork once the recording finishes', 'Why not']);
  });

  it('says nothing for a button off with no reason, whatever its card says', async () => {
    const say = vi.fn();
    r = await render(createElement('button', { type: 'button', disabled: true, 'data-tip': JSON.stringify({ t: 'Each change in the menu shows the flag it runs' }), ...shortcut('fork') }, 'Fork'));
    expect(pressShortcut('fork', say)).toBe(true);
    expect(say).not.toHaveBeenCalled();
  });
});

describe('the sheet', () => {
  it('has one Close, its lines by group, and a switch that dims them', async () => {
    const state = hand({ help: true, setHelp: () => undefined });
    r = await render(createElement(AppContext.Provider, { value: state }, createElement(Keyboard), createElement(Shortcuts, { onRun: false })));
    expect(r.all('.hgroup h4').map((h) => h.childNodes[0].textContent)).toEqual(['Anywhere', 'In a list', 'Go to', 'On a run']);
    expect(r.all('.hcol')).toHaveLength(3);
    expect(r.all('.help button').map((b) => b.textContent)).toEqual(['Single-key shortcuts', 'Close']);
    expect(r.one('.hgroup.off small').textContent).toBe('open a run to use these');
    expect(r.all('dt.sk').length).toBeGreaterThan(10);
    const sw = r.one('.help [role="switch"]');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await r.click(sw);
    expect(singleKeysOn()).toBe(false);
    expect(r.one('.help [role="switch"]').getAttribute('aria-checked')).toBe('false');
    await r.click(r.one('.help [role="switch"]'));
    expect(singleKeysOn()).toBe(true);
  });
});

describe('the key handler', () => {
  const keyboard = (state: AppState, ...rest: unknown[]) => render(createElement(AppContext.Provider, { value: state }, createElement(Keyboard), ...(rest as never[])));

  it('stops a one-character key at the switch, and leaves Esc and ⌘K', async () => {
    const setHelp = vi.fn();
    const setPalette = vi.fn();
    const keys = vi.fn(() => false);
    const location = { hash: '#/', search: '', pathname: '/' };
    vi.stubGlobal('location', location);
    r = await keyboard(hand({ setHelp, setPalette, runKeys: { current: keys } }));
    setSingleKeys(false);
    for (const k of ['?', '/', 'j', 'g', 'o']) await r.press(k);
    expect(setHelp).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
    expect(location.hash).toBe('#/');
    await r.press('k', { metaKey: true });
    expect(setPalette).toHaveBeenCalledWith(true);
    // The arrows and Enter still reach the page.
    await r.press('ArrowDown');
    expect(keys).toHaveBeenCalledOnce();
  });

  it('lets a pending g take the next key whatever it is, and its letter go to a page', async () => {
    const setHelp = vi.fn();
    const location = { hash: '#/', search: '', pathname: '/' };
    vi.stubGlobal('location', location);
    r = await keyboard(hand({ setHelp }));
    await r.press('g');
    await r.press('?');
    expect(setHelp).not.toHaveBeenCalled();
    await r.press('?');
    expect(setHelp).toHaveBeenCalledOnce();
    await r.press('g');
    const e = await r.press('r');
    expect(e.defaultPrevented).toBe(true);
    expect(location.hash).toBe('#/runs');
  });

  it('sends / to the page’s filter, a copy’s too, and opens nothing for it', async () => {
    const setPalette = vi.fn();
    r = await keyboard(hand({ setPalette, exported: true }), createElement('input', { type: 'search', id: 'runsQuery' }));
    await r.press('/');
    expect(r.focused().getAttribute('id')).toBe('runsQuery');
    expect(setPalette).not.toHaveBeenCalled();
  });
});

describe('a single-key shortcut', () => {
  it('works from a ticked run, and is typed into a field', async () => {
    const setHelp = vi.fn();
    const state = hand({ setHelp });
    r = await render(
      createElement(AppContext.Provider, { value: state }, createElement(Keyboard), createElement('input', { type: 'checkbox', 'aria-label': 'Select run' }), createElement('input', { type: 'search' }), createElement('input', { type: 'radio' }), createElement('textarea')),
    );
    const [tick, search, radio] = r.all('input');
    for (const field of [search, radio, r.one('textarea')]) {
      const typed = await r.press('?', {}, field);
      expect(typed.defaultPrevented).toBe(false);
    }
    expect(setHelp).not.toHaveBeenCalled();
    const e = await r.press('?', {}, tick);
    expect(e.defaultPrevented).toBe(true);
    expect(setHelp).toHaveBeenCalledWith(true);
  });
});
