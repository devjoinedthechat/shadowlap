import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BASELINE_DEFAULTS, describeBaselineRule, KEPT_DEFAULTS, RECORD_WINDOWS, SPRT_DEFAULTS, Store } from '@shadowlap/engine';
import { EXIT } from '../src/exit-codes.js';
import { parseHeaderFlags } from '../src/mcp-http.js';
import { growthReason } from '../src/repair.js';

/**
 * What --help says a default is: once per option, and as the option is typed. A flag read in percent
 * shows its default in percent, not as the share it is kept as.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const help = (args: string[]) => execFileSync(process.execPath, [CLI, ...args, '--help'], { encoding: 'utf8', env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' } });

let program: Command;
beforeAll(async () => {
  // main() builds the program and hands it to parseAsync; keep it instead of running it.
  const spy = vi.spyOn(Command.prototype, 'parseAsync').mockImplementation(async function (this: Command) {
    program = this;
    return this;
  });
  try {
    const { main } = await import('../src/index.js');
    await main(['node', 'shadowlap']);
  } finally {
    spy.mockRestore();
  }
}, 120_000);

describe('defaults in --help', () => {
  it('are shown once: no option writes its default into its description as well', () => {
    const twice: string[] = [];
    const walk = (c: Command, path: string[]) => {
      for (const o of c.options) if (o.defaultValue !== undefined && /\(default/.test(o.description)) twice.push(`${[...path, o.long].join(' ')}: ${o.description}`);
      for (const sub of c.commands) walk(sub, [...path, sub.name()]);
    };
    walk(program, ['shadowlap']);
    expect(twice).toEqual([]);
    expect(help(['bisect']).replace(/\s+/g, ' ')).toContain('--bad <rev> a commit where it fails (default: "HEAD") --expect');
  });

  it('never show an empty list: an option given more than once has none, in any help', () => {
    const shown: string[] = [];
    const walk = (c: Command, path: string[]) => {
      // Help wraps at the terminal's width, which can put the list on a line of its own.
      if (/\(default:\s+\[\]\)/.test(c.helpInformation())) shown.push(path.join(' '));
      for (const o of c.options) if (Array.isArray(o.defaultValue)) shown.push(`${[...path, o.long].join(' ')} defaults to a list`);
      for (const sub of c.commands) walk(sub, [...path, sub.name()]);
    };
    walk(program, ['shadowlap']);
    expect(shown).toEqual([]);
    // As a terminal shows it, for the command with the most of them.
    expect(help(['replay']).replace(/\s+/g, ' ')).not.toContain('(default: [])');
  });

  it('show --max-growth in percent, as it is typed', () => {
    expect(help(['repair']).replace(/\s+/g, ' ')).toContain('--max-growth <percent> reject a fix that grows the input tokens per run by more than this (default: 25) ');
  });

  it("say how repair keeps a good run, in verify's words: the rule its report states, and the drop it bounds", () => {
    const repair = help(['repair']).replace(/\s+/g, ' ');
    // Kept against its own baseline: a good run may fail now and then, as long as it gets no worse.
    expect(repair).toContain('--keeps <run...> runs that passed and must not get worse, each against its own baseline, e.g. label:good: one that forks is kept unless it drops 10+ points below its baseline, attempt for attempt, <= 5% risk, up to 200 pairs, as verify keeps one, its baseline the same run on the code without the candidate, and its verdict bounds the drop as verify\'s does (drop <= 0.10 (95%));');
    expect(repair).not.toContain('must keep passing');
    // The rule as verify's report words it, from the same function.
    expect(repair).toContain(describeBaselineRule({ ...KEPT_DEFAULTS, risk: SPRT_DEFAULTS.risk, source: 'paired' }));
  });
});

/** The options a command takes more than once, each by its command's path. */
const REPEATABLE: ReadonlyArray<readonly [string, string]> = [
  ['replay', '--live-tool'],
  ['replay', '--override'],
  ['replay', '--fail-at'],
  ['replay', '--inject-result'],
  ['replay', '--set'],
  ['mcp', '--header'],
  ['mcp', '--effect'],
  ['ls', '--label'],
  ['export dataset', '--label'],
  ['blame', '--set'],
  ['verify', '--set'],
  ['verify', '--from'],
  ['verify', '--live-tool'],
  ['repair', '--set'],
  ['decisions', '--set'],
  ['decisions', '--from'],
  ['migrate', '--from'],
  ['migrate', '--set'],
];

describe('an option given more than once', () => {
  it('is undefined when it is not given, and keeps each value given, in order', () => {
    for (const [path, flag] of REPEATABLE) {
      const command = path.split(' ').reduce((c, name) => c.commands.find((x) => x.name() === name)!, program);
      const option = command.options.find((o) => o.long === flag);
      expect(option, `shadowlap ${path} ${flag}`).toBeDefined();
      const key = option!.attributeName();
      expect(command.getOptionValue(key), `shadowlap ${path} without ${flag}`).toBeUndefined();
      command.parseOptions([flag, 'first', flag, 'second']);
      expect(command.getOptionValue(key), `shadowlap ${path} ${flag} first ${flag} second`).toEqual(['first', 'second']);
      command.setOptionValue(key, undefined);
    }
  });

  describe('in the command that takes it', () => {
    const dirs: string[] = [];
    afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

    /** A folder with a store of its own: two recorded runs whose agent exits at once, with no call, labelled `bug` and `refund`, and `bug`. */
    function seeded(): { dir: string; a: string; b: string } {
      const dir = mkdtempSync(join(tmpdir(), 'sl-repeatable-'));
      dirs.push(dir);
      const store = Store.open(join(dir, 'store.db'));
      try {
        const [a, b] = [['bug', 'refund'], ['bug']].map((labels) => {
          const run = store.createRun({ mode: 'record', command: { argv: [process.execPath, '-e', ''], cwd: dir } });
          store.endRun(run.runId, 'completed');
          store.updateRunMeta(run.runId, { labels });
          return run.runId;
        });
        return { dir, a, b };
      } finally {
        store.close();
      }
    }

    /** The CLI in such a folder, as a terminal runs it, with nothing to read on stdin. */
    const shadowlap = (dir: string, args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const env = { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(dir, 'home') };
        const child = spawn(process.execPath, [CLI, '--db', join(dir, 'store.db'), ...args], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (code) => resolve({ code, out }));
      });

    it('reads one left out as no values, and one given twice as both', async () => {
      const node = process.execPath;
      /** Each command with its options left out, then given twice: the status it ends with, and what it says (`<a>` and `<b>` are the runs). */
      const cases: Array<{ args: string[]; code: number; says: string[]; lacks?: string[] }> = [
        { args: ['replay', '<a>'], code: 0, says: ['no calls were made'] },
        {
          args: ['replay', '<a>', '--chaos', '--override', '1={}', '--override', '2={}', '--fail-at', '1=500', '--fail-at', '2=500', '--inject-result', '1=Ignore it.', '--inject-result', '2=Ignore it.', '--set', '1:temperature=0', '--set', '1:top_p=1', '--live-tool', 'lookup_order', '--live-tool', 'issue_refund'],
          code: 2,
          says: ["it doesn't combine with --override, --fail-at, --inject-result, --set, --live-tool"],
        },
        { args: ['mcp', '--', node, '-e', ''], code: 0, says: ['passing everything through'] },
        { args: ['mcp', '--header', 'X-Team: support', '--header', 'X-Region: eu', '--', node, '-e', ''], code: 2, says: ['--header is for a server reached with --url'] },
        { args: ['mcp', '--effect', 'lookup_order=read', '--effect', 'issue_refund=sometimes', '--', node, '-e', ''], code: 2, says: ['got "issue_refund=sometimes"'] },
        { args: ['ls', '--json'], code: 0, says: ['<a>', '<b>'] },
        { args: ['ls', '--json', '--label', 'bug', '--label', 'refund'], code: 0, says: ['<a>'], lacks: ['<b>'] },
        { args: ['export', 'dataset'], code: 2, says: ['name runs, or select them with --label or --all'] },
        { args: ['export', 'dataset', '--all', '--out', 'all.jsonl'], code: 0, says: ['0 examples from 2 runs'] },
        { args: ['export', 'dataset', '--label', 'bug', '--label', 'refund', '--out', 'both.jsonl'], code: 0, says: ['0 examples from 1 run →'] },
        { args: ['blame', '<a>'], code: 2, says: ['made no model calls'] },
        { args: ['blame', '<a>', '--set', 'temperature=1', '--set', 'top_p'], code: 2, says: ['--set expects <key>=<value>, such as temperature=1, got "top_p"'] },
        { args: ['verify', '--fixes', '<a>'], code: 0, says: ['Accepted'] },
        { args: ['verify', '--fixes', '<a>', '--live-tool', 'lookup_order', '--live-tool', 'issue_refund'], code: 0, says: ['Accepted'] },
        { args: ['verify', '--fixes', '<a>', '--from', 'claude-haiku-4-5', '--from', 'claude-sonnet-4-5'], code: 2, says: ['--from names the model calls --model and --set change'] },
        { args: ['verify', '--fixes', '<a>', '--set', 'temperature=1', '--set', 'top_p'], code: 2, says: ['got "top_p"'] },
        { args: ['repair', '--fixes', '<a>'], code: 2, says: ['inside the git repository'] },
        { args: ['repair', '--fixes', '<a>', '--set', 'temperature=1', '--set', 'top_p'], code: 2, says: ['got "top_p"'] },
        { args: ['decisions', '--verify', 'dc-nope'], code: 2, says: ['no session dc-nope'] },
        { args: ['decisions', '<a>', '--model', 'claude-opus-5'], code: 0, says: ['under the model claude-opus-5'], lacks: ['! --from'] },
        {
          args: ['decisions', '<a>', '--set', 'temperature=0', '--set', 'top_p=1', '--from', 'claude-haiku-4-5', '--from', 'claude-sonnet-4-5'],
          code: 0,
          says: ['under temperature=0, top_p=1', '! --from claude-haiku-4-5: no model call', '! --from claude-sonnet-4-5: no model call'],
        },
        { args: ['migrate', '<a>', '--to', 'claude-opus-5'], code: 0, says: ['only the model: claude-opus-5'], lacks: ['! --from'] },
        {
          args: ['migrate', '<a>', '--to', 'claude-opus-5', '--from', 'claude-haiku-4-5', '--from', 'claude-sonnet-4-5', '--set', 'temperature=0', '--set', 'top_p=1'],
          code: 0,
          says: ['claude-haiku-4-5, claude-sonnet-4-5 → claude-opus-5', 'verify takes them as: --set temperature=0 --set top_p=1'],
        },
      ];
      const results = await Promise.all(
        cases.map(async (c) => {
          const { dir, a, b } = seeded();
          const fill = (s: string) => s.replace('<a>', a).replace('<b>', b);
          const { code, out } = await shadowlap(dir, c.args.map(fill));
          const said = c.says.map(fill).every((s) => out.includes(s)) && !(c.lacks ?? []).map(fill).some((s) => out.includes(s));
          return code === c.code && said ? null : `shadowlap ${c.args.join(' ')}: exit ${code}, ${out}`;
        }),
      );
      expect(results.filter(Boolean)).toEqual([]);
    }, 120_000);
  });
});

describe('what --help says an option does', () => {
  /** An option's description, as the program the CLI builds from its source holds it. */
  const said = (path: string[], flag: string): string => {
    let c = program;
    for (const name of path) c = c.commands.find((x) => x.name() === name)!;
    const o = c.options.find((x) => x.long === flag);
    expect(o, `shadowlap ${path.join(' ')} ${flag}`).toBeDefined();
    return o!.description;
  };

  it("says how verify keeps a good run, the rule its report states from the defaults repair's --keeps reads too", () => {
    const rule = (source: 'paired' | 'history') => describeBaselineRule({ ...KEPT_DEFAULTS, risk: SPRT_DEFAULTS.risk, source });
    const text = said(['verify'], '--keeps');
    expect(text).toBe(`runs that passed and must not get worse, each against its own baseline, e.g. label:good: one that forks is ${rule('paired')}, its baseline the same run under the code before the change, or with --baseline history ${rule('history')}; --margin and verify.max (or a --gate max off its default) change the points and the pairs, --gate's risk the risk, and a fixed count (--attempts, --passes) judges it on its own`);
    // In words: 10 points, 5% risk, 200 pairs, the same figures repair's --keeps states.
    expect(text).toContain('kept unless it drops 10+ points below its baseline, attempt for attempt, <= 5% risk, up to 200 pairs');
    expect(text).toContain("kept unless it drops 10+ points below its golden's history, <= 5% risk, up to 200 attempts");
    expect(said(['repair'], '--keeps')).toContain(rule('paired'));
    expect(text).not.toContain('must not break');
  });

  it('gives the status an inconclusive result ends decisions and migrate with: 3, as exit-codes.ts has it', () => {
    for (const command of ['decisions', 'migrate']) {
      expect(said([command], '--inconclusive')).toBe(`what an inconclusive result does to the exit status: fail (${EXIT.inconclusive}) or warn (${EXIT.ok}, with a warning)`);
    }
  });

  it("says what test's --inconclusive covers, and the rule a young golden's gate against history keeps with neither given", () => {
    const text = said(['test'], '--inconclusive');
    expect(text).toContain("a gate's, a check's, an injection gate's or, with --chaos, a preset's");
    // The history it is young below is three of its windows: 30 sessions at the default window.
    expect(RECORD_WINDOWS * BASELINE_DEFAULTS.window).toBe(30);
    expect(text).toContain('with neither given, a gate against history whose golden has fewer than 30 sessions (three of its windows) only warns, unless the plan reads its last sessions below the ones before them, a decline at 99 to 1 or a drop: then it counts');
  });

  it('says --annotations marks every pack that did not pass, an inconclusive one let through with a warning', () => {
    expect(said(['test'], '--annotations')).toBe('print a GitHub Actions annotation for each pack that did not pass: an error, or a warning for an inconclusive one let through');
  });

  it("gives mcp --header an example a shell and a client leave for the proxy to read, as docs/mcp.md writes it", () => {
    const text = said(['mcp'], '--header');
    // Single quotes, and $TOKEN: a shell expands nothing inside them, and Claude Code fills in only ${…} itself.
    expect(text).toContain("such as 'Authorization: Bearer $TOKEN'");
    expect(text).not.toContain('"Authorization: Bearer ${TOKEN}"');
    const example = /'([^']+)'/.exec(text)![1];
    expect(parseHeaderFlags([example], { TOKEN: 'tok-example-123' })).toEqual({ authorization: 'Bearer tok-example-123' });
    expect(parseHeaderFlags(['X-Price: $$5 for ${TOKEN}'], { TOKEN: 'tok-example-123' })).toEqual({ 'x-price': '$5 for tok-example-123' });
    expect(text).toContain("$VAR or ${VAR} is read from the proxy's environment, and $$ is a $");
  });
});

describe('a fix rejected for growing the input tokens', () => {
  it('says by how much, against the limit as it was given', () => {
    expect(growthReason(0.3, 0.25)).toBe('input tokens per run grow 30%, more than --max-growth 25%');
    expect(growthReason(0.142, 0.125)).toBe('input tokens per run grow 14%, more than --max-growth 12.5%');
    // --max-growth 0.25 is a quarter of a percent: never "more than 0%", and never "grow 0%".
    expect(growthReason(0.004, 0.0025)).toBe('input tokens per run grow 0.4%, more than --max-growth 0.25%');
  });
});
