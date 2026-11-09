import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type StoredCoverageGroup } from '@shadowlap/engine';
import { withDismissals } from '../src/dismissals.js';
import { adviceOf, isAdviceKey } from '../src/needs-look/advice.js';
import { LOOK_CAP, type LookSource, type LookWork, needsLook, type NeedsLookRow } from '../src/needs-look/index.js';
import { retireFacts } from '../src/needs-look/retire.js';
import { overviewSummary, type StoreNote } from '../src/overview.js';
import { localRunSet, teamStoreStatus } from '../src/team-store.js';
import type { GoldenSource } from '../src/tests.js';
import { addRun, DAY } from './read-model-store.js';

/**
 * Dismiss, on Needs a look's advice only: behaviours no golden covers, runs only on this machine, a
 * model the goldens use that retires. Each states its facts, worked out on the server; put away, it
 * stays so while every fact it states was among those kept (the engine's stillDismissed), so only a
 * fact it didn't state then brings it back. The mock's walks (its README's Dismiss), over a real store.
 */

const NOW = Date.UTC(2026, 9, 19, 10);
const TEAM = 's3://northwind-agent-runs/support-agent';
let store: Store;

beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

/** The team store as the summary job reads it: every run only here, by `localRunSet`. */
function note(): StoreNote {
  const status = teamStoreStatus(store, { store: TEAM })!;
  return { name: status.name, onlyLocal: status.onlyLocal, localRuns: [...localRunSet(store, status.key)].sort() };
}

const look = (o: { goldens?: GoldenSource[]; teamStore?: StoreNote | null; now?: number } = {}) => overviewSummary(store, { tz: 'UTC', now: o.now ?? NOW, goldens: o.goldens ?? [], teamStore: o.teamStore ?? null }).needsLook;
const row = (kind: NeedsLookRow['kind'], o: Parameters<typeof look>[0] = {}) => look(o).items.find((x) => x.kind === kind);

const golden = (path: string, runId: string): GoldenSource => ({ path, runId, packedAt: null, mode: 'replay', repeat: 1, passes: 1, checks: [] });
/** A recording that calls claude-sonnet-4-5 through Anthropic's API, which retires on Nov 30, 2026 by the table. */
const sonnet = () => addRun(store, { startedAt: NOW - DAY, calls: [{ code: 'l', endMeta: { provider: 'anthropic' } }] });

/** A coverage scan with these behaviours, those named in `covered` with a golden. */
function scan(id: string, keys: string[], covered: string[] = []): void {
  const capture = addRun(store, { startedAt: NOW - DAY, calls: 'l', meta: { covers: ['api'], imported: { at: NOW - DAY, from: 'prod.har' } } });
  const group = (key: string, i: number): StoredCoverageGroup => ({ key, scanId: id, behaviour: { path: [`tool_${i}`], writes: [], unknown: [], outcome: 'answered' }, runs: 1, runIds: [capture], sources: ['prod.har'], firstSeen: NOW - DAY, lastSeen: NOW - DAY + i, coveredBy: covered.includes(key) ? ['goldens/refund'] : [], nearest: null, command: null, packed: null });
  store.saveCoverageScan({ scanId: id, at: NOW - 1_000, runs: 1, groups: keys.length, uncovered: keys.length - covered.length, goldens: 1, actor: null, data: null }, keys.map(group));
}

const put = (advice: { key: string; facts: string[] } | undefined) => store.putDismissal({ key: advice!.key, facts: advice!.facts });

describe('advice', () => {
  it('names its kinds by the engine’s key forms, and nothing else', () => {
    for (const key of ['coverage', 'local', 'retire claude-sonnet-4-5', 'retire gemini-2.0-flash']) expect(isAdviceKey(key), key).toBe(true);
    for (const key of ['', 'attn:local', 'attn:coverage:aaaa', 'retire', 'retire ', 'retire two words', 'licence', 'failed', 'Coverage', `retire ${'m'.repeat(1100)}`, 7, null]) expect(isAdviceKey(key), String(key)).toBe(false);
  });

  it('states each fact once, sorted, says when it comes back, and is not put away until the store says so', () => {
    expect(adviceOf('local', ['RUN_B', 'RUN_A', 'RUN_B'])).toEqual({ key: 'local', facts: ['RUN_A', 'RUN_B'], until: 'Until another run is only on this machine', dismissed: false });
    expect(adviceOf('coverage', ['bbbb', 'aaaa']).until).toBe('Until another behaviour has no golden');
    expect(adviceOf('retire claude-sonnet-4-5', ['retires 2026-11-30']).until).toBe('Until a new date or golden');
    expect(() => adviceOf('attn:test', ['x'])).toThrow(/no advice/);
  });

  it('is only on the rows that advise: a failure, a setup and an inconclusive test have none', () => {
    addRun(store, { startedAt: NOW - DAY, status: 'failed', calls: 'll' });
    addRun(store, { startedAt: NOW - DAY, calls: 'l' });
    scan('S1', ['aaaa000011112222']);
    const goldens = [golden('goldens/refund', sonnet())];
    store.setTeamSync(TEAM, { data: { setup: { startedAt: NOW, ci: null, ciProvider: null, finishedAt: null } } });
    const items = look({ goldens, teamStore: { ...note(), setup: { step: 2, title: 'Check access' } } }).items;
    expect(items.map((x) => [x.kind, x.advice?.key ?? null])).toEqual([
      ['store-setup', null],
      ['unblamed', null],
      ['coverage', 'coverage'],
      ['local', 'local'],
      ['retire', 'retire claude-sonnet-4-5'],
    ]);
    // Every advice row states at least one fact: one stating none would stay put away for good.
    for (const x of items) if (x.advice) expect(x.advice.facts.length, x.kind).toBeGreaterThan(0);
  });
});

describe('the facts each advice states', () => {
  it('runs only here: every one, as localRunSet has them, never the status’s first 500', () => {
    for (let i = 0; i < 3; i++) addRun(store, { startedAt: NOW - DAY + i, calls: 'l' });
    addRun(store, { startedAt: NOW, calls: 'l', status: 'running' });
    const n = note();
    const advice = row('local', { teamStore: n })!.advice!;
    expect(advice.facts).toEqual([...localRunSet(store, TEAM)].sort());
    expect(advice.facts).toHaveLength(n.onlyLocal);
    expect(n.onlyLocal).toBe(3);
  });

  it('behaviours no golden covers: every one’s key, whichever is newest', () => {
    scan('S1', ['aaaa', 'bbbb', 'cccc'], ['bbbb']);
    expect(row('coverage')!.advice).toEqual({ key: 'coverage', facts: ['aaaa', 'cccc'], until: 'Until another behaviour has no golden', dismissed: false });
  });

  it('a model that retires: its day, or deprecated without one, then each golden that calls it, then what a migration checked', () => {
    const run = sonnet();
    expect(row('retire', { goldens: [golden('goldens/refund-flow', run), golden('goldens/digest', run)] })!.advice!.facts).toEqual(['goldens/digest', 'goldens/refund-flow', 'retires 2026-11-30']);
    expect(retireFacts({ retires: '2026-11-30', goldens: ['goldens/refund-flow'] })).toEqual(['retires 2026-11-30', 'goldens/refund-flow']);
    expect(retireFacts({ retires: null, goldens: ['goldens/mythos'] })).toEqual(['deprecated', 'goldens/mythos']);
    // Once a migration has checked it (port/migrate passes its line), what that found is a fact too.
    expect(retireFacts({ retires: '2026-11-30', goldens: ['goldens/refund-flow'] }, 'checked · the config change is ready')).toEqual(['retires 2026-11-30', 'goldens/refund-flow', 'checked · the config change is ready']);
  });
});

describe('the rule, walked as the design walks it', () => {
  it('behaviours: dismissed at 4, one packed, it stays put away at 3; another seen brings it back', () => {
    scan('S1', ['aaaa', 'bbbb', 'cccc', 'dddd']);
    put(row('coverage')!.advice);
    expect(row('coverage')).toMatchObject({ title: '4 behaviours seen in production have no golden', advice: { dismissed: true } });
    scan('S2', ['aaaa', 'bbbb', 'cccc', 'dddd'], ['bbbb']);
    expect(row('coverage')).toMatchObject({ title: '3 behaviours seen in production have no golden', advice: { dismissed: true } });
    scan('S3', ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'], ['bbbb']);
    expect(row('coverage')).toMatchObject({ title: '4 behaviours seen in production have no golden', advice: { facts: ['aaaa', 'cccc', 'dddd', 'eeee'], dismissed: false } });
  });

  it('runs only here: dismissed at 2, a third finishing brings it back, at 3', () => {
    addRun(store, { startedAt: NOW - DAY, calls: 'l' });
    addRun(store, { startedAt: NOW - DAY + 1, calls: 'l' });
    const third = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: NOW });
    put(row('local', { teamStore: note() })!.advice);
    // Still recording, it isn't only here yet: the row stays put away.
    expect(row('local', { teamStore: note() })).toMatchObject({ title: '2 runs are only on this machine', advice: { dismissed: true } });
    store.endRun(third.runId, 'completed', NOW + 1_000);
    expect(row('local', { teamStore: note() })).toMatchObject({ title: '3 runs are only on this machine', advice: { dismissed: false } });
  });

  it('a model that retires: put away, the day passing keeps it so; a golden that calls it brings it back', () => {
    const run = sonnet();
    const one = [golden('goldens/refund-flow', run)];
    put(row('retire', { goldens: one })!.advice);
    expect(row('retire', { goldens: one })).toMatchObject({ title: 'claude-sonnet-4-5, used by 1 golden, retires on Nov 30, 2026', advice: { dismissed: true } });
    // Retiring to retired is no fact.
    expect(row('retire', { goldens: one, now: Date.UTC(2026, 11, 5) })).toMatchObject({ title: 'claude-sonnet-4-5, used by 1 golden, retired on Nov 30, 2026', advice: { dismissed: true } });
    expect(row('retire', { goldens: [...one, golden('goldens/refund-in-limit', run)] })).toMatchObject({ advice: { dismissed: false } });
  });

  it('keeps, on a second Dismiss, only the facts stated then', () => {
    scan('S1', ['aaaa', 'bbbb']);
    put(row('coverage')!.advice);
    scan('S2', ['bbbb', 'cccc']);
    expect(row('coverage')!.advice!.dismissed).toBe(false);
    put(row('coverage')!.advice);
    expect(store.getDismissal('coverage')!.facts).toEqual(['bbbb', 'cccc']);
    expect(row('coverage')!.advice!.dismissed).toBe(true);
    // aaaa was put away the first time only: back, it brings the row back.
    scan('S3', ['aaaa', 'bbbb']);
    expect(row('coverage')!.advice!.dismissed).toBe(false);
  });

  it('outlives its row: gone, then back with the same facts, it stays put away', () => {
    scan('S1', ['aaaa', 'bbbb']);
    put(row('coverage')!.advice);
    scan('S2', ['aaaa', 'bbbb'], ['aaaa', 'bbbb']);
    expect(row('coverage')).toBeUndefined();
    scan('S3', ['aaaa', 'bbbb'], ['bbbb']);
    expect(row('coverage')).toMatchObject({ advice: { facts: ['aaaa'], dismissed: true } });
  });
});

describe('the list with what was put away', () => {
  it('keeps advice put away in its place, counts what is left, and stamps it with the counter read before the list', () => {
    addRun(store, { startedAt: NOW - DAY, status: 'failed', calls: 'll' });
    scan('S1', ['aaaa']);
    const before = look();
    expect(before).toMatchObject({ total: 2, dismissals: 0 });
    put(before.items.find((x) => x.kind === 'coverage')!.advice);
    const after = look();
    expect(after.items.map((x) => [x.kind, x.advice?.dismissed ?? null])).toEqual([
      ['unblamed', null],
      ['coverage', true],
    ]);
    expect(after).toMatchObject({ total: 1, dismissals: store.changeCounts().dismissals });
    expect(after.dismissals).toBeGreaterThan(0);
    store.deleteDismissal('coverage');
    expect(look()).toMatchObject({ total: 2, dismissals: store.changeCounts().dismissals });
    expect(look().dismissals).toBeGreaterThan(after.dismissals);
  });

  it('gives the line for the rest of a source no advice: rows folded into it can’t be put away, and it counts as many as it stands for', () => {
    const many: LookSource = {
      id: 'many',
      group: 'housekeeping',
      order: 99,
      rows: () => Array.from({ length: LOOK_CAP + 3 }, (_, i): NeedsLookRow => ({ key: `attn:m${i}`, group: 'housekeeping', kind: 'retire', icon: 'retire', title: `m${i}`, detail: '', step: null, href: '#/changes', runId: null, fixId: null, at: i, advice: adviceOf(`retire m${i}`, ['deprecated']) })),
    };
    const list = needsLook({} as LookWork, [many]);
    expect(list.items.at(-1)).toMatchObject({ key: 'attn:rest:many', more: 3 });
    expect(list.items.at(-1)!.advice).toBeUndefined();
    store.putDismissal({ key: 'retire m0', facts: ['deprecated'] });
    store.putDismissal({ key: `retire m${LOOK_CAP + 1}`, facts: ['deprecated'] });
    const kept = withDismissals(list, store);
    expect(kept.items[0].advice!.dismissed).toBe(true);
    expect(kept.total).toBe(LOOK_CAP - 1 + 3);
  });
});
