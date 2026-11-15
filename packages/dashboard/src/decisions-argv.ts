/**
 * `shadowlap decisions`' arguments, built once for the job that runs it (decisionsJob in
 * decisions.ts) and for the dialog that shows its command, so the flags a page shows are the flags
 * that run. No imports: the browser's bundle uses this file as it is.
 */

/** A model's name as a preview's job takes it, and its dialog's field. */
export const MODEL_NAME = /^[\w.:@/-]{1,200}$/;
/** A request field's name: letters, digits, `_` and dots, a dotted name a path. */
export const FIELD_NAME = /^[A-Za-z_][\w.]{0,99}$/;

/** The most runs, or goldens, one preview takes: its job refuses more, and Runs' Preview change waits past it. */
export const PREVIEW_MAX = 500;

/** Why one preview can't take `picked` runs, in the words Runs' bulk bar says it; null within the limit. */
export function tooManyToPreview(picked: number): string | null {
  const num = (n: number) => n.toLocaleString('en-US');
  return picked > PREVIEW_MAX ? `At most ${num(PREVIEW_MAX)} runs are previewed at once: ${num(picked)} are picked` : null;
}

/** The value `--set` reads from text, as a dialog's typed value and the estimate read it: JSON where it parses, else the text. */
export function typedValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** `--set` flags, each value as text already (the engine's `fieldValue`). */
export const setFlags = (set: ReadonlyArray<readonly [string, string]>): string[] => set.flatMap(([field, text]) => ['--set', `${field}=${text}`]);

/** `--from` flags: the recorded models a switch changes. */
export const fromFlags = (models: readonly string[]): string[] => models.flatMap((m) => ['--from', m]);

/** `--scope`: a scope's name, or `none` for the calls made in none; nothing without one. */
export const scopeFlags = (scope: string | null | undefined): string[] => (scope ? ['--scope', scope] : []);

/** The most a Stop at $ takes, in USD, as Run injection test's does. */
export const BUDGET_MAX = 100_000;

/** `--budget`: Stop at $, to the cent; nothing without one. */
export const budgetFlags = (usd: number | null | undefined): string[] => (typeof usd === 'number' && usd > 0 ? ['--budget', usd.toFixed(2)] : []);

/** What a Stop at $ field holds, as an amount to the cent above 0 and at most BUDGET_MAX, or null for none or one that isn't. */
export function stopAt(text: string): number | null {
  const usd = Number(text.trim().replace(/^\$/, ''));
  return text.trim() && Number.isFinite(usd) && usd > 0 && usd <= BUDGET_MAX ? Math.round(usd * 100) / 100 : null;
}

/** A preview as its job takes it, checked: its targets as resolved (run ids, golden paths) and its change. */
export interface DecisionsArgs {
  targets: readonly string[];
  model?: string | null;
  set?: ReadonlyArray<readonly [string, string]>;
  from?: readonly string[];
  scope?: string | null;
  fromCode?: boolean;
  samples?: number | null;
  thenVerify?: boolean;
  /** Stop at $: no request sent, nor verify attempt started, once this much is spent. */
  budget?: number | null;
}

/** A migration as its job takes it, checked: the model it switches to, its goldens or runs, and what it switches. */
export interface MigrateArgs {
  to: string;
  targets: readonly string[];
  from?: readonly string[];
  scope?: string | null;
  set?: ReadonlyArray<readonly [string, string]>;
  /** Stop at $: no request sent, nor attempt started, once this much is spent. */
  budget?: number | null;
}

/**
 * `migrate` with its targets and flags in the order its job runs them, for the job and every place
 * that shows its command (a retiring model's row, Preview's next step, Migrate's start page, the
 * palette); consent's `--yes` is the job's to add.
 */
export function migrateArgv(o: MigrateArgs): string[] {
  return ['migrate', '--to', o.to, ...o.targets, ...fromFlags(o.from ?? []), ...scopeFlags(o.scope), ...setFlags(o.set ?? []), ...budgetFlags(o.budget)];
}

/** `decisions` with its targets and flags in the order its job runs them; consent's `--yes` is the job's to add. */
export function decisionsArgv(o: DecisionsArgs): string[] {
  return [
    'decisions',
    ...o.targets,
    ...(o.model ? ['--model', o.model] : []),
    ...setFlags(o.set ?? []),
    ...fromFlags(o.from ?? []),
    ...scopeFlags(o.scope),
    ...(o.fromCode ? ['--from-code'] : []),
    ...(typeof o.samples === 'number' ? ['--samples', String(o.samples)] : []),
    ...(o.thenVerify ? ['--then-verify'] : []),
    ...budgetFlags(o.budget),
  ];
}
