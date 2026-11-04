import type { Key } from 'ink';
import type { Dispatch, SetStateAction } from 'react';
import { markKey, type CallRecord, type RunMark, type RunRecord } from '@shadowlap/engine';
import { TAB_KEYS, type InspectorView, type PlayState, type Tab } from './Inspector.js';
import type { Tone } from './Row.js';
import { FILTERS, type Filter, type Mode } from './timeline-state.js';

/** Playback speeds, as a video player has them: 0 is as fast as it goes. */
const SPEEDS = [1, 2, 4, 0];

/** What the timeline's keys read and change. */
export interface TimelineKeys {
  run: RunRecord;
  query: string;
  filter: Filter;
  zoom: boolean;
  focus: 'list' | 'inspector';
  tabs: readonly Tab[];
  selectedNo: number | null;
  /** The call in front of you. */
  current: CallRecord | undefined;
  visibleCalls: readonly CallRecord[];
  /** The call blame found the run lost at. */
  lost: number | null;
  listRows: number;
  /** Where the inspector is scrolled to, as it last drew. */
  view: { readonly current: InspectorView };
  setQuery: (q: string) => void;
  setFilter: Dispatch<SetStateAction<Filter>>;
  setZoom: (z: boolean) => void;
  setFocus: (f: 'list' | 'inspector') => void;
  setTab: Dispatch<SetStateAction<Tab>>;
  setMode: (m: Mode) => void;
  setScroll: (s: number | null) => void;
  setPlay: Dispatch<SetStateAction<PlayState>>;
  select: (i: number) => void;
  move: (by: number | 'first' | 'last') => void;
  scrollBy: (n: number) => void;
  /** Selects the call the run forked at; false for a run that didn't fork. */
  toFork: () => boolean;
  /** Selects the next call worth a look, either way. */
  jump: (dir: 1 | -1) => void;
  say: (text: string, ms?: number, tone?: Tone) => void;
  onBack: () => void;
  onHelp: () => void;
  onOpenRun: (runId: string) => void;
  onMark?: ((runId: string, mark: RunMark) => string) | undefined;
  canNote: boolean;
  toDashboard: () => void;
  yank: () => void;
  writeOut: () => void;
}

/** A key pressed in the timeline: Esc backs out a step, a key does what the footer says, and movement goes to the focused pane. */
export function timelineKey(input: string, key: Key, k: TimelineKeys): void {
  if (key.escape) return escape(k);
  // Ctrl and Alt chords are none of these keys (Ctrl-G is not g).
  if (key.ctrl || key.meta) return;
  if (viewKey(input, key, k) || runKey(input, k)) return;
  moveKey(input, key, k);
}

/** Esc: clears a filter, then a zoom, then the inspector's focus, then goes back. */
function escape(k: TimelineKeys): void {
  if (k.query || k.filter !== 'all') {
    k.setQuery('');
    k.setFilter('all');
  } else if (k.zoom) {
    k.setZoom(false);
    k.setFocus('list');
  } else if (k.focus === 'inspector') k.setFocus('list');
  else k.onBack();
}

/** The keys of the view itself: back, help, the fork menu, a filter, zoom, the panes and the inspector's tabs. */
function viewKey(input: string, key: Key, k: TimelineKeys): boolean {
  if (input === 'q') k.onBack();
  else if (input === '?') k.onHelp();
  else if (input === ':') k.setMode({ kind: 'actions' });
  else if (input === '/') k.setMode({ kind: 'search', before: k.query, beforeNo: k.selectedNo });
  else if (input === 'z') {
    k.setZoom(!k.zoom);
    k.setFocus(k.zoom ? 'list' : 'inspector');
  } else if (key.leftArrow || input === 'h') {
    k.setZoom(false);
    k.setFocus('list');
  } else if (key.rightArrow || input === 'l') k.setFocus('inspector');
  else if (key.tab) {
    const by = key.shift ? k.tabs.length - 1 : 1;
    k.setTab((t) => k.tabs[(k.tabs.indexOf(t) + by) % k.tabs.length]!);
  } else if (/^[1-9]$/.test(input)) {
    // By the tab's own number, which a run without one leaves unused: 5 is a fork's diff, 6 the verdict.
    const t = TAB_KEYS[Number(input) - 1];
    if (t && k.tabs.includes(t)) k.setTab(t);
  } else if (input === 'J') k.scrollBy(1);
  else if (input === 'K') k.scrollBy(-1);
  else return false;
  return true;
}

/** The keys that act on the run or the call in front of you. */
function runKey(input: string, k: TimelineKeys): boolean {
  const { run } = k;
  const mark = markKey(input);
  if (input === 'd') {
    if (!k.toFork()) k.say('this run did not diverge: it has no diff');
    else k.setTab('diff');
  } else if (input === 'f') k.setFilter((f) => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length]!);
  else if (input === 'v') k.setTab('verdict');
  else if (input === 'N') {
    if (!k.canNote) k.say('notes can be added from the dashboard or with shadowlap note');
    else k.setMode({ kind: 'note', callNo: k.current?.callNo ?? null });
  } else if (input === 'b') toLost(k);
  else if (mark) {
    if (k.onMark) k.say(k.onMark(run.runId, mark), 4000, 'info');
  } else if (input === 'n') {
    if (!k.toFork()) k.say('this run did not diverge');
  } else if (input === ']') k.jump(1);
  else if (input === '[') k.jump(-1);
  else if (input === 'o') k.toDashboard();
  else if (input === 'y') k.yank();
  else if (input === 'w') k.writeOut();
  else if (input === 'p') {
    if (run.parentRunId) k.onOpenRun(run.parentRunId);
    else k.say('this run has no parent');
  } else return playKey(input, k);
  return true;
}

/** `b`: the call blame found the run lost at, or why there is none. */
function toLost(k: TimelineKeys): void {
  const { run, lost } = k;
  if (lost === null) return k.say(run.meta?.blame ? 'blame placed the failure on no call' : `not blamed: shadowlap blame ${run.runId.slice(0, 10)} finds where it was lost`);
  const i = k.visibleCalls.findIndex((c) => c.callNo >= lost);
  k.select(i >= 0 ? i : k.visibleCalls.length - 1);
}

/** Space plays the response, and the speed goes up and down as a video player's does; + and - mark the run, as on the dashboard. */
function playKey(input: string, k: TimelineKeys): boolean {
  if (input === ' ') {
    k.setTab('response');
    k.setPlay((p) => (p.playing ? { ...p, playing: false } : { ...p, playing: true, upto: p.upto > 0 && !p.playing ? 0 : p.upto }));
  } else if (input === '>' || input === '.') k.setPlay((p) => ({ ...p, speed: SPEEDS[(SPEEDS.indexOf(p.speed) + 1) % SPEEDS.length]! }));
  else if (input === '<' || input === ',') k.setPlay((p) => ({ ...p, speed: SPEEDS[(SPEEDS.indexOf(p.speed) + SPEEDS.length - 1) % SPEEDS.length]! }));
  else return false;
  return true;
}

/** Movement, in the focused pane: the inspector scrolls, the list moves the selection. */
function moveKey(input: string, key: Key, k: TimelineKeys): void {
  const down = key.downArrow || input === 'j';
  const up = key.upArrow || input === 'k';
  if (k.focus === 'inspector' || k.zoom) {
    if (down) k.scrollBy(1);
    else if (up) k.scrollBy(-1);
    else if (key.pageDown) k.scrollBy(k.view.current.page);
    else if (key.pageUp) k.scrollBy(-k.view.current.page);
    else if (input === 'g') k.setScroll(0);
    else if (input === 'G') k.setScroll(k.view.current.max);
    return;
  }
  if (down) k.move(1);
  else if (up) k.move(-1);
  else if (key.pageDown) k.move(k.listRows);
  else if (key.pageUp) k.move(-k.listRows);
  else if (input === 'g') k.move('first');
  else if (input === 'G') k.move('last');
}
