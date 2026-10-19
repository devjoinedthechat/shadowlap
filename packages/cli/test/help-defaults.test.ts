import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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
});

describe('a fix rejected for growing the input tokens', () => {
  it('says by how much, against the limit as it was given', () => {
    expect(growthReason(0.3, 0.25)).toBe('input tokens per run grow 30%, more than --max-growth 25%');
    expect(growthReason(0.142, 0.125)).toBe('input tokens per run grow 14%, more than --max-growth 12.5%');
    // --max-growth 0.25 is a quarter of a percent: never "more than 0%", and never "grow 0%".
    expect(growthReason(0.004, 0.0025)).toBe('input tokens per run grow 0.4%, more than --max-growth 0.25%');
  });
});
