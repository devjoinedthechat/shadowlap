import { useSyncExternalStore } from 'react';
import { ACTIONS } from './labels.js';
import { GO_KEYS } from './route.js';

/**
 * Every key the dashboard answers to, declared once. The shortcuts sheet draws this table, a control
 * says its key by spreading `shortcut(id)` (so `aria-keyshortcuts` and its hover card read it from
 * there, and a key finds its control by `data-shortcut`), and the palette's key column reads it too.
 * A single key can be turned off on the sheet, and the browser remembers it (`setSingleKeys`): off,
 * only ⌘K, Esc, Enter and the arrows work, and nothing advertises a single key. No DOM at import: the
 * tests import it.
 */

export type SheetGroup = 'Anywhere' | 'In a list' | 'Go to' | 'On a run';

/** Where the sheet opens, which is what decides some of its lines and words. */
export interface SheetPlace {
  exported: boolean;
  onRun: boolean;
  onRuns: boolean;
  /** An exported copy that holds two runs or more, so it can compare. */
  compares: boolean;
}

interface Shortcut {
  /** Its line on the sheet; none for a key that a line of its own already covers (`1` under `1 – 4`). */
  group?: SheetGroup;
  /** How it is drawn, space between keys: `then` and `–` go between keys, ⌘ reads Ctrl off a Mac. */
  chips: string;
  /** As `aria-keyshortcuts` writes it, where a control answers to it: a plus sign is the word Plus. */
  aria?: string;
  label?: string | ((p: SheetPlace) => string);
  /** A card's title where the control has no words of its own for it. */
  card?: string;
  when?: (p: SheetPlace) => boolean;
}

const notCopy = (p: SheetPlace) => !p.exported;

const TABLE = {
  palette: { group: 'Anywhere', chips: '⌘ K', aria: 'Meta+K Control+K', label: 'Search or jump to anything', when: notCopy },
  filter: { group: 'Anywhere', chips: '/', label: (p) => (p.onRun ? 'Filter calls' : p.onRuns ? 'Filter runs' : 'Search or jump to anything'), when: (p) => !p.exported || p.onRun || p.onRuns },
  help: { group: 'Anywhere', chips: '?', aria: '?', label: 'Show these shortcuts' },
  undo: { group: 'Anywhere', chips: 'u', aria: 'u', label: 'Undo, while a toast offers it' },
  up: { group: 'Anywhere', chips: 'Esc', label: 'Close menu or dialog, then go up a level' },

  rows: { group: 'In a list', chips: 'j k', label: 'Next or previous row' },
  rowArrows: { group: 'In a list', chips: '↓ ↑', label: 'The same, on a row in focus' },
  rowOpen: { group: 'In a list', chips: '↵', label: 'Open row' },
  rowActions: { group: 'In a list', chips: '⌘ K', label: 'The row’s actions', when: notCopy },
  rowPick: { group: 'In a list', chips: 'x', label: 'Select row, on Runs', when: notCopy },
  rowMark: { group: 'In a list', chips: '+ -', label: 'Label it good or bad, on Runs', when: notCopy },
  rowUp: { group: 'In a list', chips: 'Esc', label: (p) => (p.exported ? 'Let go of the row' : 'Clear selection, then let go') },

  goOverview: { group: 'Go to', chips: 'g then o', label: 'Overview', when: notCopy },
  goRuns: { group: 'Go to', chips: 'g then r', label: 'Runs' },
  goCompare: { group: 'Go to', chips: 'g then c', label: 'Compare', when: (p) => !p.exported || p.compares },
  goFixes: { group: 'Go to', chips: 'g then f', label: 'Fixes', when: notCopy },
  goTests: { group: 'Go to', chips: 'g then t', label: 'Tests', when: notCopy },
  goTraining: { group: 'Go to', chips: 'g then a', label: 'Training', when: notCopy },
  goSettings: { group: 'Go to', chips: 'g then s', label: 'Settings', when: notCopy },

  calls: { group: 'On a run', chips: 'j k', label: 'Next or previous call' },
  nextCall: { chips: 'j', aria: 'j', card: 'Next call' },
  prevCall: { chips: 'k', aria: 'k', card: 'Previous call' },
  callArrows: { group: 'On a run', chips: '↓ ↑', label: 'The same, in the calls list' },
  stepRun: { group: 'On a run', chips: '[ ]', label: 'Previous or next run in the list' },
  parts: { group: 'On a run', chips: '1 – 4', label: 'Switch inspector tab' },
  part1: { chips: '1', aria: '1' },
  part2: { chips: '2', aria: '2' },
  part3: { chips: '3', aria: '3' },
  part4: { chips: '4', aria: '4' },
  tabArrows: { group: 'On a run', chips: '← →', label: 'Previous or next tab, in a tab list' },
  fold: { group: 'On a run', chips: '← →', label: 'In Calls, fold or open a call’s group' },
  view: { group: 'On a run', chips: 'v', aria: 'v', label: 'Next view' },
  jump: { group: 'On a run', chips: 'n', aria: 'n', label: 'Jump to fork, lost call or first failure' },
  parent: { group: 'On a run', chips: 'p', aria: 'p', label: 'Open parent run' },
  replay: { group: 'On a run', chips: 'r', aria: 'r', label: ACTIONS.replay.label, card: ACTIONS.replay.label, when: notCopy },
  compare: { group: 'On a run', chips: 'c', aria: 'c', label: (p) => (p.exported ? 'Compare with parent' : 'Compare'), when: (p) => !p.exported || p.compares },
  blame: { group: 'On a run', chips: 'b', aria: 'b', label: `${ACTIONS.runBlame.label}, where it is the next step`, card: ACTIONS.runBlame.label, when: notCopy },
  fork: { group: 'On a run', chips: 'f', aria: 'f', label: 'Fork at selected call', when: notCopy },
  marks: { group: 'On a run', chips: '+ -', label: 'Label it good or bad; again to take it off', when: notCopy },
  markGood: { chips: '+', aria: 'Plus' },
  markBad: { chips: '-', aria: '-' },
  back: { group: 'On a run', chips: 'Esc', label: 'Back to where you came from' },
  pick: { chips: 'x' },
} satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof TABLE;

const JOINS: ReadonlySet<string> = new Set(['then', '–']);

/** Whether a line's keys are all single keys: not ⌘K, Esc, Enter or the arrows, which the switch leaves on. */
function isSingle(chips: string): boolean {
  return chips.split(' ').every((c) => JOINS.has(c) || (c.length === 1 && !/[⌘←→↑↓↵]/.test(c)));
}

export interface SheetLine {
  id: ShortcutId;
  /** Each key and what goes between them, in the order drawn. */
  chips: Array<{ text: string; join: boolean }>;
  label: string;
  single: boolean;
}

/** A group's lines, as the sheet draws them for where it opened. */
export function sheetLines(group: SheetGroup, place: SheetPlace, mac: boolean): SheetLine[] {
  const lines: SheetLine[] = [];
  for (const id of Object.keys(TABLE) as ShortcutId[]) {
    const s: Shortcut = TABLE[id];
    if (s.group !== group || (s.when && !s.when(place))) continue;
    const chips = s.chips.split(' ').map((text) => ({ text: text === '⌘' && !mac ? 'Ctrl' : text, join: JOINS.has(text) }));
    lines.push({ id, chips, label: typeof s.label === 'function' ? s.label(place) : (s.label ?? ''), single: isSingle(s.chips) });
  }
  return lines;
}

/** What the switch's sentence says stays on: an exported copy has no palette. */
export function switchSentence(exported: boolean, paletteKey: string): string {
  return `Off, only ${exported ? '' : `${paletteKey}, `}Esc, Enter and the arrows work.`;
}

const STORED = 'shadowlap-single-keys';
let on: boolean | null = null;
const listeners = new Set<() => void>();

/** Whether single-key shortcuts are on: read from the browser on first use, on where it can't say. */
export function singleKeysOn(): boolean {
  if (on === null) {
    try {
      on = localStorage.getItem(STORED) !== 'off';
    } catch {
      on = true;
    }
  }
  return on;
}

/** Turns them on or off for this browser; it works without storage, for this page only. */
export function setSingleKeys(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(STORED, next ? 'on' : 'off');
  } catch {
    // Remembered for this page only.
  }
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The switch, read so a component draws again when it moves. The third argument is for tests that draw to a string, where every key is on. */
export function useSingleKeys(): boolean {
  return useSyncExternalStore(subscribe, singleKeysOn, () => true);
}

export interface ShortcutMark {
  'aria-keyshortcuts'?: string;
  'data-shortcut'?: ShortcutId;
}

/**
 * What a control spreads to say its key: to a screen reader and on its hover card, and so the key
 * finds it. A single key's mark is gone while the switch is off. Something above the control reads
 * `useSingleKeys`, so it draws again as the switch moves.
 */
export function shortcut(id: ShortcutId): ShortcutMark {
  const s: Shortcut = TABLE[id];
  if (!s.aria || (isSingle(s.chips) && !singleKeysOn())) return {};
  return { 'aria-keyshortcuts': s.aria, 'data-shortcut': id };
}

/** A card's title for a key whose control has no words of its own. */
export function shortcutCard(id: ShortcutId): string | null {
  const s: Shortcut = TABLE[id];
  return s.card ?? null;
}

/** A key as the palette's column draws it, one kbd per word (`g o`); nothing while the switch is off. */
export function keyColumn(id: ShortcutId): string | undefined {
  return singleKeysOn() ? TABLE[id].chips.replaceAll(' then ', ' ') : undefined;
}

/** The `g` chord that leads to a page, by where it leads: a renamed page keeps its key. */
export function goKeyColumn(to: string): string | undefined {
  const key = Object.keys(GO_KEYS).find((k) => GO_KEYS[k] === to);
  return key && singleKeysOn() ? `g ${key}` : undefined;
}

/** A card's words, from its `data-tip`: its title and the line under it. */
function cardWords(el: Element): string | null {
  const raw = el.getAttribute('data-tip');
  if (!raw) return el.getAttribute('title');
  try {
    const v = JSON.parse(raw) as { t?: string; s?: string };
    return v.s ?? v.t ?? null;
  } catch {
    return raw;
  }
}

/**
 * A key presses its control, so it does what the button does and waits as it waits: none on the page,
 * nothing; one that is off says why it is off (`say`); else a click. True when there was one to press.
 */
export function pressShortcut(id: ShortcutId, say: (words: string) => void): boolean {
  const el = document.querySelector<HTMLElement>(`[data-shortcut="${id}"]`);
  if (!el) return false;
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') {
    const why = cardWords(el);
    if (why) say(why);
    return true;
  }
  el.click();
  return true;
}
