import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLAME_DEFAULTS, SPRT_DEFAULTS } from '@shadowlap/engine';
import { attemptRule, readGate } from '../src/commands/fix.js';

/**
 * How `blame`, `verify` and `repair` decide on their attempts: a gate by default (`--gate` changes
 * its figures), or the fixed count of before when `--attempts` or `--passes` is given.
 */
const verify = { defaults: SPRT_DEFAULTS, passes: (n: number) => Math.ceil(0.8 * n) };
const blame = { defaults: BLAME_DEFAULTS, passes: (n: number) => Math.min(2, n) };

describe('attemptRule', () => {
  it('decides by the command\'s own gate when given nothing', () => {
    expect(attemptRule({}, verify)).toEqual({ gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 }, attempts: 80, needed: 0 });
    expect(attemptRule({}, blame)).toEqual({ gate: { kind: 'sprt', good: 0.6, bad: 0.1, risk: 0.05, max: 20 }, attempts: 20, needed: 0 });
  });

  it('fills a partial --gate from the command\'s defaults', () => {
    expect(attemptRule({ gate: '{"good":0.95,"bad":0.8}' }, verify).gate).toEqual({ kind: 'sprt', good: 0.95, bad: 0.8, risk: 0.05, max: 80 });
    expect(attemptRule({ gate: '{"good":0.5}' }, blame).gate).toEqual({ kind: 'sprt', good: 0.5, bad: 0.1, risk: 0.05, max: 20 });
  });

  it('keeps the fixed count of before when --attempts or --passes is given', () => {
    expect(attemptRule({ attempts: 5 }, verify)).toEqual({ gate: null, attempts: 5, needed: 4 });
    expect(attemptRule({ attempts: 2 }, verify)).toEqual({ gate: null, attempts: 2, needed: 2 });
    expect(attemptRule({ passes: 3 }, verify)).toEqual({ gate: null, attempts: 5, needed: 3 });
    expect(attemptRule({ attempts: 5 }, blame)).toEqual({ gate: null, attempts: 5, needed: 2 });
    expect(attemptRule({ attempts: 1 }, blame)).toEqual({ gate: null, attempts: 1, needed: 1 });
  });

  it('refuses both, and a count it can\'t run', () => {
    expect(() => attemptRule({ attempts: 5, gate: '{}' }, verify)).toThrow('give a gate (--gate) or a fixed count (--attempts, --passes), not both');
    expect(() => attemptRule({ attempts: 101 }, verify)).toThrow('--attempts is at most 100');
    expect(() => attemptRule({ attempts: 3, passes: 4 }, blame)).toThrow("--passes (4) can't be more than --attempts (3)");
  });
});

describe('readGate', () => {
  it('reads JSON or a file, and says what is wrong in the gate\'s own words', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-gate-flag-'));
    writeFileSync(join(dir, 'gate.json'), '{"risk":0.01,"max":120}');
    expect(readGate(`@${join(dir, 'gate.json')}`, SPRT_DEFAULTS)).toEqual({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.01, max: 120 });
    expect(() => readGate('good=0.9', SPRT_DEFAULTS)).toThrow(`--gate takes JSON or @file.json, such as '{"good":0.9,"bad":0.7,"risk":0.05,"max":80}'`);
    expect(() => readGate('{"good":0.9,"repeat":3}', SPRT_DEFAULTS)).toThrow('--gate has an unknown key "repeat" (expected "good", "bad", "risk", "max")');
    expect(() => readGate('{"max":5}', SPRT_DEFAULTS)).toThrow('--gate: max (5) is fewer than the 12 attempts an agent that always passes needs');
    expect(() => readGate('{"baseline":"history"}', SPRT_DEFAULTS)).toThrow('a gate against history belongs to a golden, under "tests" in shadowlap.config.json');
    expect(() => readGate(`@${join(dir, 'missing.json')}`, SPRT_DEFAULTS)).toThrow('--gate: cannot read');
  });
});
