import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BASELINE_DEFAULTS, describeBaselineRule, KEPT_DEFAULTS, RECORD_WINDOWS, SPRT_DEFAULTS } from '@shadowlap/engine';
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
