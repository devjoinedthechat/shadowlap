/**
 * `shadowlap decisions`' arguments, built once for the job that runs it (decisionsJob in
 * decisions.ts) and for the dialog that shows its command, so the flags a page shows are the flags
 * that run. No imports: the browser's bundle uses this file as it is.
 */

/** The most runs, or goldens, one preview takes: its job refuses more, and Runs' Preview change waits past it. */
export const PREVIEW_MAX = 500;

/** Why one preview can't take `picked` runs, in the words Runs' bulk bar says it; null within the limit. */
export function tooManyToPreview(picked: number): string | null {
  const num = (n: number) => n.toLocaleString('en-US');
  return picked > PREVIEW_MAX ? `At most ${num(PREVIEW_MAX)} runs are previewed at once: ${num(picked)} are picked` : null;
}

/** `--set` flags, each value as text already (the engine's `fieldValue`). */
export const setFlags = (set: ReadonlyArray<readonly [string, string]>): string[] => set.flatMap(([field, text]) => ['--set', `${field}=${text}`]);

/** `--from` flags: the recorded models a switch changes. */
export const fromFlags = (models: readonly string[]): string[] => models.flatMap((m) => ['--from', m]);

/** `--scope`: a scope's name, or `none` for the calls made in none; nothing without one. */
export const scopeFlags = (scope: string | null | undefined): string[] => (scope ? ['--scope', scope] : []);

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
  ];
}
