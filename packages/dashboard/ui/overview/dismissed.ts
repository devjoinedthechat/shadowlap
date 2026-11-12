import type { LookGroup } from '../../src/needs-look/groups.js';
import type { NeedsLookRow } from '../types.js';

/**
 * Needs a look's advice put away, as the page shows it: the server says which rows are (each
 * advice's `dismissed`), and a press (Dismiss, Restore, Undo) moves a row at once, the page holding
 * its own view of it until a list at or past its write's dismissals counter arrives, after which the
 * server's word rules again. A list asked for before the write can land after it: it is older, so it
 * never brings a row back. What is held, and which groups' Dismissed (n) are open, are kept here for
 * the page's life, per project, since the counter is one store's: leaving the Overview and coming
 * back finds a fold as it was left. No DOM and no React here: the tests import it.
 */

/** A press the server's list may not have yet: the row put away (Dismiss) or back (Restore, Undo). */
export interface HeldPress {
  dismissed: boolean;
  /** The dismissals counter its write answered with; null until it answers, which holds it whatever list arrives. */
  stamp: number | null;
}

export type Held = ReadonlyMap<string, HeldPress>;

/** What the page keeps for one project. */
interface Kept {
  held: Held;
  /** The groups whose Dismissed (n) is open. */
  open: ReadonlySet<string>;
}

const NONE: Kept = { held: new Map(), open: new Set() };
const kept = new Map<string, Kept>();
const listeners = new Set<() => void>();

const keptFor = (project: string): Kept => kept.get(project) ?? NONE;
function change(project: string, next: Kept): void {
  kept.set(project, next);
  for (const l of listeners) l();
}

/** For `useSyncExternalStore`: what changes it. */
export function subscribeLook(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** For `useSyncExternalStore`: the same object until something it holds changes. */
export const lookMemory = (project: string): Kept => keptFor(project);

/** Holds a press until a list at or past its stamp arrives. */
export function hold(project: string, key: string, press: HeldPress): void {
  const k = keptFor(project);
  change(project, { ...k, held: new Map(k.held).set(key, press) });
}

/** Puts back what was held for `key` before a press the server refused: a press, or nothing. */
export function holdBack(project: string, key: string, was: HeldPress | undefined): void {
  const k = keptFor(project);
  const held = new Map(k.held);
  if (was) held.set(key, was);
  else held.delete(key);
  change(project, { ...k, held });
}

/** Lets go of every press a list at `stamp` has caught up with: the server's word rules for them. */
export function settle(project: string, stamp: number | undefined): void {
  if (stamp === undefined) return;
  const k = keptFor(project);
  const held = new Map([...k.held].filter(([, p]) => p.stamp === null || p.stamp > stamp));
  if (held.size !== k.held.size) change(project, { ...k, held });
}

/** Opens or folds a group's Dismissed (n). */
export function setFold(project: string, group: string, open: boolean): void {
  const k = keptFor(project);
  if (k.open.has(group) === open) return;
  const next = new Set(k.open);
  if (open) next.add(group);
  else next.delete(group);
  change(project, { ...k, open: next });
}

/** Forgets everything kept: for the tests. */
export function resetLookMemory(): void {
  kept.clear();
  for (const l of listeners) l();
}

/** Whether a row is put away: a press held for its advice, until the list has caught up with it, else the server's word. */
export function isDismissed(x: NeedsLookRow, held: Held, stamp?: number): boolean {
  if (!x.advice) return false;
  const press = held.get(x.advice.key);
  if (press && (press.stamp === null || stamp === undefined || stamp < press.stamp)) return press.dismissed;
  return x.advice.dismissed;
}

/** A group as the panel draws it: its rows left to look at, those put away, and its count. */
export interface LookGroupRows {
  group: LookGroup;
  open: NeedsLookRow[];
  dismissed: NeedsLookRow[];
  /** What is left to look at in it: a row each, a line for the rest of a source as many as it stands for. */
  count: number;
}

/** The rows by group, in the list's order (a group's rows come together), each put away or not. */
export function lookGroups(items: readonly NeedsLookRow[], held: Held, stamp?: number): LookGroupRows[] {
  const out: LookGroupRows[] = [];
  for (const x of items) {
    let g = out.at(-1);
    if (g?.group !== x.group) out.push((g = { group: x.group, open: [], dismissed: [], count: 0 }));
    if (isDismissed(x, held, stamp)) g.dismissed.push(x);
    else {
      g.open.push(x);
      g.count += x.more ?? 1;
    }
  }
  return out;
}

/** What is left to look at, the panel's count: the server's, moved by each press its list doesn't have yet. */
export function leftOf(items: readonly NeedsLookRow[], total: number, held: Held, stamp?: number): number {
  let left = total;
  for (const x of items) {
    if (!x.advice) continue;
    const off = isDismissed(x, held, stamp);
    if (off !== x.advice.dismissed) left += off ? -(x.more ?? 1) : (x.more ?? 1);
  }
  return left;
}

/** The rows in the order they are drawn, for j and k: each group's rows left, then its open fold's. */
export function drawnRows(groups: readonly LookGroupRows[], open: ReadonlySet<string>): NeedsLookRow[] {
  return groups.flatMap((g) => (open.has(g.group) ? [...g.open, ...g.dismissed] : g.open));
}
