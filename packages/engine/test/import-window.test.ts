import { describe, expect, it } from 'vitest';
import { importMoment, importWindowArgs, importWindowFieldProblem, importWindowProblem } from '../src/import-window.js';

/**
 * The window an import without a trace id reads, checked as `shadowlap import` checks its flags
 * (cli/src/commands/import.ts), for the dashboard's Import capture: each field in the CLI's words,
 * and the window as the arguments the CLI takes.
 */

const NOW = Date.parse('2026-11-14T12:00:00Z');

describe('the import window', () => {
  it('reads a moment as the CLI does: a date, a time, or how long ago', () => {
    expect(importMoment('30d', NOW)).toBe(NOW - 30 * 86_400_000);
    expect(importMoment(' 12h ', NOW)).toBe(NOW - 12 * 3_600_000);
    expect(importMoment('2026-09-30', NOW)).toBe(Date.parse('2026-09-30'));
    expect(importMoment('2026-09-30T14:00Z', NOW)).toBe(Date.parse('2026-09-30T14:00Z'));
    for (const bad of ['yesterday', '30', '3w', '-1d', '2026-13-45', '']) expect(importMoment(bad, NOW), bad).toBeNull();
  });

  it('says what is wrong with a field in the CLI’s words, and nothing of one left empty', () => {
    expect(importWindowFieldProblem('since', 'last week', NOW)).toBe('--since: a date (2026-09-30), a time (2026-09-30T14:00Z), or how long ago (30d, 12h), not "last week"');
    expect(importWindowFieldProblem('since', '2027-01-01', NOW)).toBe('--since: "2027-01-01" is not a moment in the past');
    expect(importWindowFieldProblem('until', '2027-01-01', NOW)).toBeNull();
    expect(importWindowFieldProblem('limit', '0', NOW)).toBe('--limit: a number of traces from 1 to 10000, not "0"');
    expect(importWindowFieldProblem('limit', '10001', NOW)).toBe('--limit: a number of traces from 1 to 10000, not "10001"');
    expect(importWindowFieldProblem('limit', '250', NOW)).toBeNull();
    expect(importWindowFieldProblem('traceName', 'refund\nflow', NOW)).toBe("--trace-name: a trace's name as the store shows it, on one line");
    for (const field of ['since', 'until', 'limit', 'traceName'] as const) expect(importWindowFieldProblem(field, '  ', NOW)).toBeNull();
  });

  it('refuses a window that ends before it starts, and gives each field as one argument', () => {
    expect(importWindowProblem({ since: '2d', until: '3d' }, NOW)).toBe('--until: "3d" is not after --since');
    expect(importWindowProblem({ until: '40d' }, NOW)).toBe('--until: "40d" is not after --since');
    expect(importWindowProblem({ since: '7d', limit: '50', traceName: 'refund-flow' }, NOW)).toBeNull();
    expect(importWindowArgs({ since: ' 7d ', until: '', limit: '50', traceName: '--json' })).toEqual(['--since=7d', '--limit=50', '--trace-name=--json']);
  });
});
