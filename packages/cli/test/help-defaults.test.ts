import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { describeBaselineRule, KEPT_DEFAULTS, SPRT_DEFAULTS } from '@shadowlap/engine';
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
    expect(repair).toContain('--keeps <run...> runs that pass and must keep passing, e.g. label:good: one that forks is kept unless it drops 10+ points below its baseline, attempt for attempt, <= 5% risk, up to 200 pairs, as verify keeps one, its baseline the same run on the code without the candidate, and its verdict bounds the drop as verify\'s does (drop <= 0.10 (95%));');
    // The rule as verify's report words it, from the same function.
    expect(repair).toContain(describeBaselineRule({ ...KEPT_DEFAULTS, risk: SPRT_DEFAULTS.risk, source: 'paired' }));
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
