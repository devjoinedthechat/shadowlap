import type { ReactNode } from 'react';
import { copyText } from '../dom.js';
import { useApp } from '../state.js';
import { Command } from './Copy.js';
import { Icon } from './Icon.js';
import { tipCard, tipText } from './HoverCard.js';

/**
 * The code box: a command (`.cmdline`), a block of code (`pre.codebox`) or a file (`.codewrap`, its
 * name in its header), each with one Copy and no other, the one way a box is copied. Copy is named
 * by what it copies, without an article (Copy command, Copy commands, Copy whole command, Copy
 * policy); its toast keeps the sentence's article ("Copied the command"). It takes the whole thing,
 * never the `$`: a box of several commands copies one a line, a shortened one its whole text
 * (`full`). A box that shows a change has no Copy (`change`): it is read, not pasted. A file's
 * change is its lines, each marked as added or removed (`lines`, as `patchLines` reads a hunk), with
 * what acts on the file at its header's right as one group (`actions`: Open in editor, Copy git revert);
 * without a file, the lines alone (Revert's dialog, which names the commit above them). Every box of
 * marked lines is this one.
 */
export interface CodeBoxProps {
  /** A command, or several, one a line, each shown as `Command` sets it. */
  command?: string | readonly string[];
  /** A block of code, as written. */
  code?: string;
  /** The file the code is, named in the box's header. */
  file?: string;
  /** The whole command, where the box shows it shortened: what Copy takes. */
  full?: string;
  /** What the box holds, with its article, where it isn't a command or code: "the policy", "the CI step". */
  what?: string;
  /** A box that shows a change: read, not pasted, so it has no Copy. */
  change?: boolean;
  /** A change, in place of `code`: each line marked as added or removed, the box's own Copy none; a file's under its name. */
  lines?: ReadonlyArray<{ text: string; tone: 'add' | 'del' | null }>;
  /** At the right of a file's header, as one group that takes a row of its own where the header can't hold it beside the name. */
  actions?: ReactNode;
  className?: string | undefined;
  /** A command box's, for what folds it. */
  id?: string | undefined;
}

/** What a box's Copy names and its toast says: what the box names itself, else the whole command, the commands, the command or the code. */
export function boxWhat({ command, full, what }: Pick<CodeBoxProps, 'command' | 'full' | 'what'>): string {
  if (what) return what;
  if (full) return 'the whole command';
  if (command === undefined) return 'the code';
  return typeof command !== 'string' && command.length > 1 ? 'the commands' : 'the command';
}

/**
 * Copies, and says so in a toast (`Copied` and what, `label`, or the text itself): the one copy
 * button, its words beside the icon (`children`), or the icon alone, named by `name` for a screen
 * reader and on hover. Every Copy on a page is this one.
 */
export function CopyButton({ text, label, children = 'Copy', className = 'linkbtn', name, sub, cmd }: { text: string; label?: string; children?: ReactNode; className?: string; name?: string; /** A line under its name, on its card. */ sub?: string; /** What it copies runs, on its card's `$` row. */ cmd?: string }) {
  const { toast } = useApp();
  return (
    <button
      type="button"
      className={className}
      aria-label={name}
      data-tip={name ? (sub ? tipCard(name, [], sub, cmd) : tipText(name)) : undefined}
      onClick={() => {
        void copyText(text).then((ok) => toast(ok ? `Copied ${label ?? text}` : 'Copying was refused by the browser'));
      }}
    >
      <Icon name="copy" />
      {children}
    </button>
  );
}

/**
 * The box's Copy, named by what it copies, its article dropped: an icon in the box's corner, or its
 * words at the end of a file's header (`words`), where the file it names says whose it is, so the
 * golden's or the workflow's is dropped too ("Copy entry"; its toast "Copied the golden’s entry").
 */
function BoxCopy({ text, what, words = false }: { text: string; what: string; words?: boolean }) {
  const label = `Copy ${what.replace(words ? /^the (?:golden’s |workflow )?|^an? / : /^(?:the|a|an) /, '')}`;
  return words ? (
    <CopyButton text={text} label={what}>
      {label}
    </CopyButton>
  ) : (
    <CopyButton text={text} label={what} className="boxcopy" name={label}>
      {null}
    </CopyButton>
  );
}

/** A change's lines, each added or removed one in its colour (`--add` ink, `--del` red). */
function MarkedLines({ lines }: { lines: NonNullable<CodeBoxProps['lines']> }) {
  return (
    <>
      {lines.map((l, i) => (
        <span key={i} className={l.tone ?? undefined}>
          {l.text}
          {i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </>
  );
}

/** One code box, with its one Copy: a command, code, or a file of code with its name in the header. */
export function CodeBox(props: CodeBoxProps) {
  const { command, code = '', file, full, change = false, lines, actions, className, id } = props;
  const what = boxWhat(props);
  if (command !== undefined) {
    const lines = typeof command === 'string' ? [command] : command;
    return (
      <div id={id} className={`cmdline${className ? ` ${className}` : ''}`}>
        {change ? null : <BoxCopy text={full ?? lines.join('\n')} what={what} />}
        {lines.map((c, i) =>
          lines.length > 1 ? (
            <span key={i} className="cstep">
              <Command cmd={c} />
            </span>
          ) : (
            <Command key={i} cmd={c} />
          ),
        )}
      </div>
    );
  }
  if (file !== undefined) {
    return (
      <div className={`codewrap${className ? ` ${className}` : ''}`}>
        <div className={`codehead${actions ? ' acts' : ''}`}>
          <span>{file}</span>
          {actions ? <span className="cdacts">{actions}</span> : change || lines ? null : <BoxCopy text={code} what={what} words />}
        </div>
        {/* It scrolls sideways for a long line: by keyboard too. */}
        <pre className={`codebox${lines ? ' fxpatch' : ''}`} tabIndex={0}>
          {lines ? <MarkedLines lines={lines} /> : code}
        </pre>
      </div>
    );
  }
  // A change, or its marked lines, is read, not pasted: it has no Copy.
  const read = change || !!lines;
  const pre = (
    <pre className={`codebox${lines ? ' fxpatch' : ''}${read && className ? ` ${className}` : ''}`} tabIndex={0}>
      {lines ? <MarkedLines lines={lines} /> : code}
    </pre>
  );
  return read ? (
    pre
  ) : (
    <div className={`boxwrap${className ? ` ${className}` : ''}`}>
      {pre}
      <BoxCopy text={code} what={what} />
    </div>
  );
}
