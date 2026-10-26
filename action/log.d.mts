// Types for log.mjs, which the action runs as plain JavaScript.

/** Text as a workflow command's data, or on a plain line: `%` and line breaks escaped. */
export function commandText(s: unknown): string;
/** A plain line for the log, on one line and never a workflow command. */
export function logLine(s: unknown): string;
/** An annotation of the action's own, its title Shadowlap's. */
export function annotation(kind: 'notice' | 'warning' | 'error', s: unknown): string;
/** Another program's output, each line that would start a workflow command escaped. */
export function logLines(text: unknown): string;
