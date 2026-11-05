import { CodeBox } from './CodeBox.js';

export interface CommandRowProps {
  /** The command the job then runs, following the fields: a string is one command, whatever it holds; a chain comes as a list, a line a command. */
  command: string | readonly string[];
  /** The whole command, where the row shows it shortened: what its Copy takes. */
  full?: string | undefined;
  /** What the box holds, where it isn't a command: "the commands". */
  what?: string | undefined;
  className?: string | undefined;
  /** For the button that folds it on a phone. */
  id?: string | undefined;
}

/**
 * A job dialog's `$` row, over its cost line, with the box's one Copy. A string is never split: a
 * `&&` in it is what someone typed (an instruction, a command, a title), so it copies whole.
 */
export function CommandRow({ command, full, what, className, id }: CommandRowProps) {
  return <CodeBox command={typeof command === 'string' || command.length ? command : ''} className={className} id={id} {...(full ? { full } : {})} {...(what ? { what } : {})} />;
}
