// The lines the action writes to the job's log. The runner reads a line whose text starts with `::`
// as a workflow command, and one that starts with `##[` in the older form: an annotation, `add-mask`,
// or `stop-commands`, which silences every command after it, the action's own warnings among them.
// So what a run, a model, git or GitHub wrote never starts a line of its own there.

/** The runner's own reading of a line: past its leading spaces (as .NET trims them, NEL among them), a command's mark. */
const COMMAND_AT_START = /^([\s\u0085]*)(::|##\[)/;

/** A line that would start a workflow command, its first mark escaped: `%3A:` and `%23#[` read as no command. */
const unmarked = (line) => line.replace(COMMAND_AT_START, (_m, space, mark) => `${space}${mark === '::' ? '%3A:' : '%23#['}`);

/**
 * Text as a workflow command's data, or on a plain line: `%` and line breaks escaped as GitHub reads
 * a command's data, so what it holds stays on the one line and starts none of its own.
 */
export const commandText = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * A plain line for the log that carries what a run, a model, git or GitHub wrote: on one line
 * (commandText), and escaped where it would start a workflow command, so the runner reads none in it.
 */
export const logLine = (s) => unmarked(commandText(s));

/**
 * An annotation of the action's own (`notice`, `warning`, `error`), its title Shadowlap's, with what
 * it says as the command's data.
 */
export const annotation = (kind, s) => `::${kind} title=Shadowlap::${commandText(s)}`;

/**
 * What another program printed, passed on to the log as it is, line for line, but each line that
 * would start a workflow command escaped as logLine escapes one.
 */
export const logLines = (text) => String(text).split(/(\r\n|\r|\n)/).map((part, i) => (i % 2 ? part : unmarked(part))).join('');
