import { shortId } from '../format.js';
import type { RowScope } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import type { GoldenRow } from '../types.js';

/**
 * A golden's row on Tests, for ⌘K on it, and for Enter on one that leads nowhere of its own: what its
 * report opens (its run), its next step where only the verdict draws it (Open fix, Run blame), then
 * the report's buttons as the page draws them (its next step, Update golden, Find breaking
 * commit…), each waiting as its button waits and pressing that very button, so it asks and starts
 * as the button does. They are read from the page when the palette opens, so none of the report's
 * rules is written twice. A golden with no report (it passed, or hasn't run) opens its run, and one
 * with nothing to offer has no actions.
 */

type Item = ReturnType<RowScope['items']>[number];

/** A golden's report on the page, by the id each report carries. */
export const reportOf = (page: ParentNode, name: string): HTMLElement | null => page.querySelector<HTMLElement>(`section[id="report-${name.replace(/["\\]/g, '\\$&')}"]`);

/** What a button's card says it runs, else the line under its title. */
function cardHint(b: Element): string {
  try {
    const d = JSON.parse(b.getAttribute('data-tip') ?? '{}') as { s?: string; cmd?: string };
    return (d.cmd ?? d.s ?? '').replace(/^\$ /, '');
  } catch {
    return '';
  }
}

/** The buttons a part of the page draws in its action slot. */
const buttonsIn = (part: ParentNode | null | undefined): HTMLElement[] => [...(part?.querySelectorAll<HTMLElement>('.actions .btn') ?? [])];

/** A button as the palette offers it: found again in its part (`again`) when picked, as the page may have drawn it anew. */
function buttonItem(again: () => HTMLElement[], b: Element, i: number): Item {
  const label = b.textContent?.trim() ?? '';
  const why = b.getAttribute('data-why');
  return {
    label,
    hint: why ?? cardHint(b),
    ...(why ? { wait: why } : {}),
    run: () => {
      const now = again();
      (now.find((x) => x.textContent?.trim() === label) ?? now[i])?.click();
    },
  };
}

/**
 * `leads`: the golden is the one the verdict leads with, whose step the verdict draws. That step is
 * offered where its report has no button of that name: Open fix and Run blame, which only the verdict draws.
 */
export function goldenRowScope(row: Pick<GoldenRow, 'name' | 'runId'>, page: () => ParentNode | null, leads = false): RowScope | null {
  const items = (): Item[] => {
    const report = () => {
      const root = page();
      return buttonsIn(root && reportOf(root, row.name));
    };
    const verdict = () => buttonsIn(page()?.querySelector('.verdict.tv'));
    const open: Item[] = row.runId ? [{ label: 'Open run', hint: shortId(row.runId), run: () => navigate(href.run(row.runId!)) }] : [];
    const own = report();
    const labels = new Set(own.map((b) => b.textContent?.trim()));
    const step = leads ? verdict().filter((b) => !labels.has(b.textContent?.trim())) : [];
    return [...open, ...step.map((b, i) => buttonItem(verdict, b, i)), ...own.map((b, i) => buttonItem(report, b, i))];
  };
  return items().length ? { name: row.name, items } : null;
}

/**
 * The row's key: where it leads, as Runs keys its rows, so Esc back from its run lands on it; its
 * path where it leads nowhere or another row leads to the same run (two goldens packed from one
 * recording, until either has a result).
 */
export function goldenKeys(rows: readonly Pick<GoldenRow, 'path' | 'runId'>[]): (row: Pick<GoldenRow, 'path' | 'runId'>) => string {
  const leads = new Map<string, number>();
  for (const r of rows) if (r.runId) leads.set(r.runId, (leads.get(r.runId) ?? 0) + 1);
  return (r) => (r.runId && leads.get(r.runId) === 1 ? href.run(r.runId) : r.path);
}
