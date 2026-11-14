// docs/cli.md is the reference for every command, and the docs are full of commands to copy. Nothing
// generates either from the code, so both drift: an option added without a line in the reference, a
// sample whose flag was renamed, a command a page promises that the CLI doesn't have. These checks
// read the CLI's own command tree (built by main(), without parsing anything) and hold the docs to it.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, type Option } from 'commander';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const reference = read('docs/cli.md');
const pages = [...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`), 'README.md'];

interface Entry {
  path: string;
  command: Command;
  options: Option[];
}

let program: Command;
let commands: Entry[];

beforeAll(async () => {
  // main() builds the program and hands it to parseAsync; keep it instead of running it.
  const spy = vi.spyOn(Command.prototype, 'parseAsync').mockImplementation(async function (this: Command) {
    program = this;
    return this;
  });
  try {
    const { main } = await import('../../../packages/cli/src/index.js');
    await main(['node', 'shadowlap']);
  } finally {
    spy.mockRestore();
  }
  const hidden = (c: Command) => (c as unknown as { _hidden?: boolean })._hidden === true;
  const walk = (c: Command, prefix: string[]): Entry[] =>
    c.commands
      .filter((sub) => !hidden(sub))
      .flatMap((sub) => {
        const path = [...prefix, sub.name()];
        return [{ path: path.join(' '), command: sub, options: sub.options.filter((o) => !o.hidden) }, ...walk(sub, path)];
      });
  commands = walk(program, []);
}, 120_000);

/** `--flag` or `-f` standing on its own in some text, not as part of a longer flag or word. */
const mentions = (text: string, flag: string) => new RegExp(`(?<![\\w-])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);

/** docs/cli.md split at its `## ` headings: the names in each heading ("label, note") and the section's text. */
const sections = reference
  .split(/^(?=## )/m)
  .filter((s) => s.startsWith('## '))
  .map((s) => ({ names: s.slice(3, s.indexOf('\n')).split(',').map((n) => n.trim()), text: s }));

/** The section that documents a command: the one its heading names, or its parent's ("import" for "import har"). */
function sectionOf(path: string) {
  const parent = path.split(' ')[0];
  return sections.find((s) => s.names.includes(path)) ?? sections.find((s) => s.names.includes(parent));
}

describe('docs/cli.md', () => {
  it('has a place for every command', () => {
    const missing = commands.filter((c) => !sectionOf(c.path) && !new RegExp(`shadowlap ${c.path}(?![\\w-])`).test(reference)).map((c) => c.path);
    expect(missing, 'commands docs/cli.md never mentions (give each a "## <command>" section)').toEqual([]);
  });

  it('names every option of every command in that command\'s section', () => {
    const missing: string[] = [];
    for (const c of commands) {
      const text = sectionOf(c.path)?.text ?? reference;
      for (const o of c.options) {
        const flags = [o.long, o.short].filter((f): f is string => !!f);
        if (!flags.some((f) => mentions(text, f))) missing.push(`shadowlap ${c.path} ${flags.join('/')}`);
      }
    }
    expect(missing, 'options that docs/cli.md does not document where their command is').toEqual([]);
  });

  it('names the global options', () => {
    const globals = program.options.filter((o) => !o.hidden && o.long !== '--version' && o.long !== '--help');
    expect(globals.map((o) => o.long).filter((f) => f && !mentions(reference, f))).toEqual([]);
  });

  it('can say the global options go after a command too, since every command takes them', () => {
    const globals = program.options.filter((o) => o.long === '--db' || o.long === '--verbose');
    const without = commands.filter((c) => globals.some((g) => !c.command.options.some((o) => o.long === g.long)));
    expect(without.map((c) => c.path)).toEqual([]);
  });
});

/** Every `shadowlap …` the docs show: in shell, YAML and output blocks, and in inline code that starts with it. */
function shown(): Array<{ where: string; line: string }> {
  const out: Array<{ where: string; line: string }> = [];
  for (const page of pages) {
    const md = read(page);
    for (const m of md.matchAll(/^```([\w-]*)[^\n]*\n([\s\S]*?)^```/gm)) {
      if (!['', 'sh', 'bash', 'shell', 'console', 'zsh', 'text', 'yaml', 'yml'].includes(m[1])) continue;
      for (const line of m[2].split('\n')) if (/(^|[\s"'(])shadowlap\s/.test(line)) out.push({ where: page, line });
    }
    const prose = md.replace(/^```[\s\S]*?^```/gm, '');
    for (const m of prose.matchAll(/`(?:\$ )?(shadowlap [^`\n]+)`/g)) out.push({ where: page, line: m[1] });
  }
  return out;
}

/** What may come before a command on its line: a prompt, environment settings, a runner, a YAML key or a list's dash. */
const LEAD = /^(\$|>|-|npx|exec|env|time|[\w.-]+:|[A-Z_][A-Z0-9_]*=\S*)$/;

/**
 * The commands on a line: each `shadowlap` and the words after it, up to a pipe, `;`, `&&`, `$(`, `)` or a
 * comment, and whether it starts its part of the line (`$ FOO=1 npx shadowlap …`, `run: shadowlap …`) or
 * sits in a sentence, where it can be the name alone (`2 tools shadowlap did not record`).
 */
function invocations(line: string): Array<{ words: string[]; starts: boolean }> {
  const text = line.replace(/(^|\s)#(\s.*)?$/, '$1');
  const found: Array<{ words: string[]; starts: boolean }> = [];
  for (const segment of text.split(/\|\||&&|[|;`)]|\$\(/)) {
    const words = segment.trim().split(/\s+/).map((w) => w.replace(/^["'[(]+/, ''));
    words.forEach((w, i) => {
      if (w !== 'shadowlap') return;
      const end = words.indexOf('shadowlap', i + 1);
      found.push({ words: words.slice(i + 1, end < 0 ? undefined : end), starts: words.slice(0, i).every((p) => LEAD.test(p)) });
    });
  }
  return found;
}

/** The subcommand a command runs when none is named (`.command('ls', { isDefault: true })`), if any. */
function defaultOf(command: Command): Command | undefined {
  const name = (command as unknown as { _defaultCommandName?: string })._defaultCommandName;
  return name ? command.commands.find((c) => c.name() === name) : undefined;
}

/** What is wrong with the `shadowlap` commands on these lines: commands `program` lacks, and flags they don't take. */
function problemsIn(program: Command, lines: Array<{ where: string; line: string }>): string[] {
  const takesValue = (o: Option) => o.required || o.optional;
  const problems: string[] = [];
  for (const { where, line } of lines) {
    for (const { words, starts } of invocations(line)) {
      let i = 0;
      // Global options come first: shadowlap --db replays.db test …
      while (i < words.length && words[i].startsWith('-')) {
        const g = program.options.find((o) => o.long === words[i] || o.short === words[i]);
        if (!g) break;
        i += takesValue(g) ? 2 : 1;
      }
      if (i >= words.length || !/^[a-z][a-z-]*$/.test(words[i])) continue;
      let command: Command = program;
      const path: string[] = [];
      for (;;) {
        const sub = command.commands.find((c) => c.name() === words[i] || c.aliases().includes(words[i]));
        if (!sub) break;
        command = sub;
        path.push(words[i]);
        i++;
      }
      if (!path.length) {
        // In a sentence, a word no command has follows the name, not a command: "2 tools shadowlap did not record".
        if (starts) problems.push(`${where}: shadowlap has no command "${words[i]}" (${line.trim()})`);
        continue;
      }
      // With no subcommand named, a command that has a default one runs it: `tasks --json` is `tasks ls --json`.
      const fallback = defaultOf(command);
      if (command.commands.length && i < words.length && /^[a-z][a-z-]*$/.test(words[i]) && !fallback?.registeredArguments.length) {
        problems.push(`${where}: shadowlap ${path.join(' ')} has no command "${words[i]}" (${line.trim()})`);
        continue;
      }
      const known = new Set(['--help', '-h']);
      // The global options too: every command takes them after its name as well (shadowlap ls --db other.db).
      for (const o of [...command.options, ...(fallback?.options ?? []), ...program.options]) for (const f of [o.long, o.short]) if (f) known.add(f);
      for (const w of words.slice(i)) {
        const word = w.replace(/[\])},…]+$|\.\.\.$/g, '');
        if (word === '--') break;
        const flag = /^(--?[a-zA-Z][\w-]*)(?:=.*)?$/.exec(word)?.[1];
        if (flag && !known.has(flag)) problems.push(`${where}: shadowlap ${path.join(' ')} has no ${flag} (${line.trim()})`);
      }
    }
  }
  return problems;
}

describe('the commands the docs show', () => {
  it('finds them', () => {
    // A guard against the extraction itself breaking and passing everything.
    expect(shown().length).toBeGreaterThan(150);
  });

  it('are commands the CLI has, with options those commands take', () => {
    expect(problemsIn(program, shown())).toEqual([]);
  });
});

describe('the check on the commands the docs show', () => {
  /** A CLI the size of a test: `tasks` runs `tasks ls` when no subcommand is named, as commander allows. */
  function cli(): Command {
    const p = new Command('shadowlap').option('--db <path>');
    const tasks = p.command('tasks');
    tasks.command('ls', { isDefault: true }).option('--json');
    tasks.command('score').option('--model <model>');
    p.command('replay').argument('<run>').option('--strict');
    return p;
  }
  const at = (...lines: string[]) => lines.map((line) => ({ where: 'docs/x.md', line }));

  it('takes a default subcommand\'s options where its parent is named', () => {
    expect(problemsIn(cli(), at('shadowlap tasks --json', 'shadowlap tasks', 'shadowlap --db r.db tasks score --model m', 'shadowlap replay 01K5 --strict'))).toEqual([]);
  });

  it('still finds a flag nothing there takes, and a command the CLI lacks', () => {
    expect(problemsIn(cli(), at('shadowlap tasks --nope', 'shadowlap tasks score --json', 'shadowlap tasks scroe', 'shadowlap repaly 01K5'))).toEqual([
      'docs/x.md: shadowlap tasks has no --nope (shadowlap tasks --nope)',
      'docs/x.md: shadowlap tasks score has no --json (shadowlap tasks score --json)',
      'docs/x.md: shadowlap tasks has no command "scroe" (shadowlap tasks scroe)',
      'docs/x.md: shadowlap has no command "repaly" (shadowlap repaly 01K5)',
    ]);
  });

  it('reads the name in a sentence as the name, and still checks a command wherever it stands', () => {
    expect(problemsIn(cli(), at('! The model called 2 tools shadowlap did not record', 'Next: shadowlap repaly 01K5', '$ FOO=1 npx shadowlap repaly 01K5', 'run it again with shadowlap replay 01K5 --nope'))).toEqual([
      'docs/x.md: shadowlap has no command "repaly" (Next: shadowlap repaly 01K5)',
      'docs/x.md: shadowlap has no command "repaly" ($ FOO=1 npx shadowlap repaly 01K5)',
      'docs/x.md: shadowlap replay has no --nope (run it again with shadowlap replay 01K5 --nope)',
    ]);
  });
});
