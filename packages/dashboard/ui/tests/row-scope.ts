import { shortId } from '../format.js';
import type { RowScope } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import type { GoldenRow } from '../types.js';

/**
 * A golden's row on Tests, for ⌘K on it: what its report opens (its run), then the report's buttons
 * as the page draws them (its next step, Update golden, Find breaking commit…), each waiting as its
 * button waits and pressing that very button, so it asks and starts as the button does. They are
 * read from the page when the palette opens, so none of the report's rules is written twice. A golden
 * with no report (it passed, or hasn't run) opens its run.
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

/** One of the report's buttons as the palette offers it: found again when picked, as the page may have drawn the report anew. */
function buttonItem(page: () => ParentNode | null, name: string, b: Element, i: number): Item {
  const label = b.textContent?.trim() ?? '';
  const why = b.getAttribute('data-why');
  return {
    label,
    hint: why ?? cardHint(b),
    ...(why ? { wait: why } : {}),
    run: () => {
      const report = page() && reportOf(page()!, name);
      const again = [...(report?.querySelectorAll<HTMLElement>('.actions .btn') ?? [])];
      (again.find((x) => x.textContent?.trim() === label) ?? again[i])?.click();
    },
  };
}

export function goldenRowScope(row: Pick<GoldenRow, 'name' | 'runId'>, page: () => ParentNode | null): RowScope {
  return {
    name: row.name,
    items: () => {
      const root = page();
      const report = root && reportOf(root, row.name);
      const open: Item[] = row.runId ? [{ label: 'Open run', hint: shortId(row.runId), run: () => navigate(href.run(row.runId!)) }] : [];
      if (!report) return open;
      return [...open, ...[...report.querySelectorAll('.actions .btn')].map((b, i) => buttonItem(page, row.name, b, i))];
    },
  };
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
