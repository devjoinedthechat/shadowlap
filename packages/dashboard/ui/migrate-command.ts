import { migrateArgv } from '../src/decisions-argv.js';
import { quoteArg } from './job-title.js';
import type { PaletteCommand } from './state.js';
import type { MigrateRetiring } from './types.js';

/**
 * What one migration switches and the command its job runs, for every place that shows it: the
 * Migrate dialog, Migrate's start page and its report's menu, and the palette's Migrate <a> to <b>,
 * which loads with the palette and so takes none of the dialog's code with it. No DOM here.
 */

/** What one migration switches: to `to`, from `from`, on the goldens named (paths), else the runs; in one scope where it keeps to one, held to its Stop at $ where it has one. */
export interface MigrateSwitch {
  from: readonly string[];
  to: string;
  goldens: readonly string[];
  runs?: readonly string[];
  scope?: string | null;
  budget?: number | null;
}

/** The command the job runs, quoted as a shell takes it. */
export const migrateCommand = (s: MigrateSwitch): string => ['shadowlap', ...migrateArgv({ to: s.to, targets: s.goldens.length ? s.goldens : (s.runs ?? []), from: s.from, scope: s.scope ?? null, budget: s.budget ?? null })].map(quoteArg).join(' ');

/**
 * The palette's Migrate <a> to <b>: one per model the goldens call that retires with a replacement,
 * to the first its notice recommends, as Migrate's start page asks it. No ellipsis: its dialog asks
 * for nothing. Its hint is the command, else why it waits; `ask` opens Migrate asking it.
 */
export function migratePaletteRows(retiring: readonly MigrateRetiring[], held: string | null, ask: (model: string) => void): PaletteCommand[] {
  return retiring.flatMap((n) => {
    const to = n.replacements[0];
    if (!to) return [];
    return [{ group: 'Actions' as const, label: `Migrate ${n.model} to ${to}`, hint: held ?? migrateCommand({ from: [n.model], to, goldens: n.goldens }), job: true, ...(held ? { wait: held } : {}), run: () => ask(n.model) }];
  });
}
