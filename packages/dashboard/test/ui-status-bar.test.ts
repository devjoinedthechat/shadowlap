import { describe, expect, it } from 'vitest';
import { STATUS_GIVES_WAY, statusParts, type StatusFacts, type StatusPart } from '../ui/shell/status.js';

/** A part's words as the bar reads them, a path or an address in backticks, what is wrong in asterisks. */
const said = (parts: StatusPart[]) => parts.map((p) => `${p.key}: ${p.words.map((w) => (typeof w === 'string' ? w : 'code' in w ? `\`${w.code}\`` : `*${w.off}*`)).join('')}`);

const NOW = new Date(2026, 9, 16, 14, 2).getTime();
const base: StatusFacts = {
  exported: false,
  store: { shown: '~/support-agent/.shadowlap/shadowlap.db', whole: '/Users/dev/support-agent/.shadowlap/shadowlap.db' },
  runs: 207,
  attempts: 427,
  exportedAt: null,
  conn: 'ok',
  readOnly: null,
  address: '127.0.0.1:4777',
  team: null,
  version: '0.1.0',
  now: NOW,
};

describe('the status bar', () => {
  it('says the store and the counts on the left; where it runs and the version on the right, paths and addresses as code', () => {
    const { left, right } = statusParts(base);
    expect(said(left)).toEqual(['st-store: store `~/support-agent/.shadowlap/shadowlap.db`', 'st-runs: 207 runs · 427 attempts']);
    expect(said(right)).toEqual(['st-where: `127.0.0.1:4777` · local only', 'st-ver: shadowlap 0.1.0']);
    // The whole path on hover.
    expect(left[0].title).toBe('/Users/dev/support-agent/.shadowlap/shadowlap.db');
  });

  it('counts in words, with no attempts part when there are none, and waits with … for the meta', () => {
    expect(said(statusParts({ ...base, runs: 1, attempts: 1 }).left)[1]).toBe('st-runs: 1 run · 1 attempt');
    expect(said(statusParts({ ...base, runs: 0, attempts: 0 }).left)[1]).toBe('st-runs: 0 runs');
    expect(said(statusParts({ ...base, runs: 12_408, attempts: 0 }).left)[1]).toBe('st-runs: 12,408 runs');
    expect(said(statusParts({ ...base, store: null, runs: null, version: null }).left)).toEqual(['st-store: store …', 'st-runs: …']);
  });

  it('says nothing of the connection to its own server but what is wrong: offline, or the link expired', () => {
    expect(statusParts(base).right.map((p) => p.key)).not.toContain('st-sync');
    expect(said(statusParts({ ...base, conn: 'offline' }).right)[0]).toBe('st-sync: *offline*');
    expect(said(statusParts({ ...base, conn: 'expired' }).right)[0]).toBe('st-sync: *link expired*');
    for (const conn of ['ok', 'offline', 'expired'] as const) expect(said(statusParts({ ...base, conn }).right).join(' ')).not.toMatch(/synced|connect/);
  });

  it('names read-only in a part of its own, its reason on hover, which never gives way', () => {
    const RO = 'This dashboard is read-only (started with --read-only): it shows runs and changes nothing.';
    const right = statusParts({ ...base, readOnly: RO, conn: 'offline' }).right;
    expect(said(right)).toEqual(['st-sync: *offline*', 'st-ro: read-only', 'st-where: `127.0.0.1:4777` · local only', 'st-ver: shadowlap 0.1.0']);
    expect(right[1].title).toBe(RO);
    expect(STATUS_GIVES_WAY).toEqual(['st-ver', 'st-where', 'st-store']);
  });

  it('puts the team store in the address’s place, named as code, saying when it last synced', () => {
    const team: NonNullable<StatusFacts['team']> = { name: 'northwind-agent-runs/support-agent', url: 's3://northwind-agent-runs/support-agent', settingUp: false, syncedAt: new Date(2026, 9, 16, 10, 14).getTime() };
    const where = (t: Partial<typeof team>) => statusParts({ ...base, team: { ...team, ...t } }).right.find((p) => p.key === 'st-where')!;
    expect(said([where({})])).toEqual(['st-where: store `northwind-agent-runs/support-agent` · synced 10:14']);
    expect(where({}).title).toBe('team store s3://northwind-agent-runs/support-agent');
    expect(said([where({ syncedAt: NOW - 20_000 })])[0]).toMatch(/· synced just now$/);
    expect(said([where({ syncedAt: new Date(2026, 9, 1, 9, 0).getTime() })])[0]).toMatch(/· synced Oct 1$/);
    expect(said([where({ syncedAt: null })])[0]).toMatch(/· not synced yet$/);
    expect(said([where({ settingUp: true })])[0]).toMatch(/· setting up$/);
  });

  it('says what an exported copy holds, when it was made and that it reads only; only its version gives way', () => {
    const { left, right } = statusParts({ ...base, exported: true, runs: 1, exportedAt: new Date(2026, 9, 1, 10, 20).getTime() });
    expect(said(left)).toEqual(['st-runs: 1 run in this copy']);
    expect(said(right)).toEqual(['st-sync: exported Oct 1, 10:20 · read-only', 'st-ver: shadowlap 0.1.0']);
  });
});
