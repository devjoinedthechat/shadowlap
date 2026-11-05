import { CodeBox } from './CodeBox.js';

export interface CommandRowProps {
  /** The command the job then runs, following the fields: a chain reads a line a command. */
  command: string | readonly string[];
  /** The whole command, where the row shows it shortened: what its Copy takes. */
  full?: string | undefined;
  /** What the box holds, where it isn't a command: "the commands". */
  what?: string | undefined;
  className?: string | undefined;
  /** For the button that folds it on a phone. */
  id?: string | undefined;
}

/** A job dialog's `$` row, over its cost line, with the box's one Copy. */
export function CommandRow({ command, full, what, className, id }: CommandRowProps) {
  const lines = typeof command === 'string' ? command.split(' && ') : command;
  return <CodeBox command={lines.length > 1 ? lines : (lines[0] ?? '')} className={className} id={id} {...(full ? { full } : {})} {...(what ? { what } : {})} />;
}
