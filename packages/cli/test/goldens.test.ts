import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packRun, Store, storeApiRequest, unpackRun } from '@shadowlap/engine';
import { parseTests } from '../src/checks.js';
import { givenCommand } from '../src/shared.js';
import { importGolden } from '../src/golden-test.js';
import { expandRecordings, goldenMode, goldenName, listGoldens, projectGoldens, rawExpectFor, readPackHead, testsKeyFor } from '../src/goldens.js';

/** Finding a project's goldens, and naming them the way the test history does. */
let project: string;

function pack(dir: string, runId: string, createdAt = 1000): void {
  mkdirSync(join(project, dir), { recursive: true });
  writeFileSync(join(project, dir, 'run.json'), JSON.stringify({ format: 'shadowlap-pack', version: 1, createdAt, runs: [{ runId: 'PARENT', command: { argv: ['node'] } }, { runId, parentRunId: 'PARENT', startedAt: createdAt - 10, command: { argv: ['node', 'agent.mjs'] } }] }));
}

const config = {
  tests: {
    'goldens/refund-*': { expect: { tools: { send_email: 0 } } },
    'goldens/refund-over-limit': { fork: true, repeat: 5, expect: { tools: { issue_refund: 0, escalate: 1 } } },
    'elsewhere/budget': { expect: { inputTokens: '<= 60000', cost: '<= 0.05' } },
    'goldens/triage': { injection: {} },
  },
};

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'sl-goldens-'));
  pack('goldens/refund-over-limit', 'R_OVER', 2000);
  pack('goldens/refund-in-limit', 'R_IN');
  pack('goldens/triage', 'R_TRIAGE');
  pack('elsewhere/budget', 'R_BUDGET');
  mkdirSync(join(project, 'goldens', 'notes'));
  pack('goldens/.scratch', 'R_HIDDEN');
  writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify(config));
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

describe('goldens', () => {
  it('lists the goldens folder and the packs the config names, with how each is tested', () => {
    const goldens = listGoldens(project, parseTests(config.tests));
    expect(goldens.map((g) => g.path)).toEqual(['goldens/refund-in-limit', 'goldens/refund-over-limit', 'goldens/triage', 'elsewhere/budget']);
    expect(goldens[1]).toEqual({ path: 'goldens/refund-over-limit', runId: 'R_OVER', packedAt: 2000, mode: 'fork', repeat: 5, passes: 5, gate: null, checks: ['issue_refund called 0 times', 'escalate called 1 time'], injection: false, injectionGate: null, judges: [], error: null });
    expect(goldens[0]).toMatchObject({ mode: 'replay', repeat: 1, checks: ['send_email called 0 times'] });
    // An injection test runs live, even for a golden that replays offline: the dashboard says CI needs the keys for it.
    expect(goldens[2]).toMatchObject({ mode: 'replay', checks: [], injection: true, judges: [] });
    // Its injection gate as parsed, with its defaults, for Tests to show among its checks.
    expect(goldens[2].injectionGate).toMatchObject({ obeyed: expect.any(Number), repeat: expect.any(Number), templates: expect.anything() });
    expect(goldens[3].checks).toEqual(['at most 60000 input tokens', 'cost at most $0.05']);
    expect(listGoldens(project, [], 'nowhere')).toEqual([]);
    // As the dashboard asks for them: from the config on disk, or the folder alone when it can't be read.
    expect(projectGoldens(project)).toEqual(goldens);
    expect(projectGoldens(project).some((g) => 'checksUnread' in g)).toBe(false);
    const broken = mkdtempSync(join(tmpdir(), 'sl-goldens-broken-'));
    try {
      mkdirSync(join(broken, 'goldens', 'a'), { recursive: true });
      writeFileSync(join(broken, 'goldens', 'a', 'run.json'), JSON.stringify({ format: 'shadowlap-pack', version: 1, createdAt: 5, runs: [{ runId: 'R_A', command: { argv: ['node'] } }] }));
      writeFileSync(join(broken, 'shadowlap.config.json'), '{ "tests": ');
      // Its checks unknown, not none: nothing says they changed until the file reads again.
      expect(projectGoldens(broken).map((g) => [g.path, g.runId, g.checks, g.checksUnread])).toEqual([['goldens/a', 'R_A', [], true]]);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('says what runs a golden live in CI besides a fork: its injection gate, and the judges a fork asks', () => {
    const [entry] = parseTests({ 'goldens/triage': { fork: true, injection: { obeyed: 0 }, expect: { judge: [{ name: 'polite', question: 'Is the reply polite?', model: 'openai:gpt-5.5' }, { name: 'short', question: 'Is it short?', model: 'openai:gpt-5.5' }] } } });
    expect(goldenMode(entry.spec)).toMatchObject({ mode: 'fork', injection: true, judges: ['openai:gpt-5.5'] });
    expect(goldenMode(null)).toMatchObject({ mode: 'replay', injection: false, judges: [] });
  });

  it('expands a pattern itself, names goldens by their folder, and finds their checks as written', () => {
    expect(expandRecordings(['goldens/refund-*', 'goldens/triage/', 'missing/*'], project)).toEqual({ dirs: ['goldens/refund-in-limit', 'goldens/refund-over-limit', 'goldens/triage/'], unmatched: ['missing/*'] });
    expect(() => expandRecordings(['*/triage'], project)).toThrow('only the last part');
    expect(goldenName('./goldens/triage/', project)).toBe('goldens/triage');
    expect(goldenName(join(project, 'elsewhere', 'budget'), project)).toBe('elsewhere/budget');
    const entries = parseTests(config.tests);
    expect(testsKeyFor(entries, join(project, 'goldens/refund-over-limit'), project)).toBe('goldens/refund-over-limit');
    expect(testsKeyFor(entries, join(project, 'goldens/refund-in-limit'), project)).toBe('goldens/refund-*');
    expect(rawExpectFor(entries, join(project, 'goldens/refund-in-limit'), project)).toEqual({ tools: { send_email: 0 } });
    expect(rawExpectFor(entries, join(project, 'goldens/triage'), project)).toBeNull();
    expect(readPackHead(join(project, 'goldens/triage'))).toEqual({ runId: 'R_TRIAGE', packedAt: 1000, recordedAt: 990, argv: ['node', 'agent.mjs'], parentRunId: 'PARENT', redactions: [] });
    expect(readPackHead(join(project, 'goldens/notes'))).toEqual({ error: 'no run.json: not a pack' });
  });

  it('keeps the command as typed, without the global options before it', () => {
    expect(givenCommand(['node', 'shadowlap', '--db', 'x.db', '-v', 'test', 'goldens/*', '--update'], 'test')).toEqual(['shadowlap', 'test', 'goldens/*', '--update']);
    expect(givenCommand(['node', 'shadowlap', 'test', 'goldens/a'], 'test')).toEqual(['shadowlap', 'test', 'goldens/a']);
  });
});

describe('importing a golden', () => {
  it('replays the pack\'s own run, even when only one of its ancestors had to be imported', () => {
    const source = Store.open(':memory:');
    const parent = source.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: '/p' } });
    const fork = source.createRun({ mode: 'replay', parentRunId: parent.runId, command: { argv: ['node', 'agent.mjs'], cwd: '/p' } });
    packRun(source, fork.runId, join(project, 'elsewhere', 'lineage'), { lineage: true });
    source.close();
    const store = Store.open(':memory:');
    expect(importGolden(store, join(project, 'elsewhere', 'lineage')).runId).toBe(fork.runId);
    store.deleteRun(parent.runId);
    expect(importGolden(store, join(project, 'elsewhere', 'lineage')).runId).toBe(fork.runId);
    store.close();
  });
});

describe('a golden whose run id the store already holds as another recording', () => {
  /** A finished recording of one model call about a ticket, from `argv`. */
  function recordTicket(store: Store, ticket: string, argv = ['node', 'agent.mjs', ticket]) {
    const run = store.createRun({ mode: 'record', command: { argv, cwd: '/p' } });
    const req = storeApiRequest(store, { model: 'm', system: 'Support agent. Escalate to ops@northwind.example.', messages: [{ role: 'user', content: `ticket ${ticket}` }] });
    const res = store.putBlob(Buffer.from(`event: message_start\ndata: {"text":"refund ${ticket}"}\n\n`));
    const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'a'.repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: req, meta: { provider: 'anthropic' }, at: 1 });
    store.appendCallEnd(id, { runId: run.runId, callNo: 1, attempt: 0, responseRef: res, outcome: 'ok', meta: { status: 200 }, at: 2 });
    store.endRun(run.runId, 'completed');
    return store.getRun(run.runId)!;
  }
  const editPack = (dir: string, edit: (m: { runs: Array<{ command: { argv: string[] }; meta?: Record<string, unknown> }> }) => void) => {
    const m = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    edit(m);
    writeFileSync(join(dir, 'run.json'), JSON.stringify(m));
  };

  it("replays its own pack's command, never the command of the store's copy", () => {
    const source = Store.open(':memory:');
    const run = recordTicket(source, 'A-1042');
    const golden = join(project, 'goldens', 'ticket-1042');
    packRun(source, run.runId, golden);
    source.close();

    // A pack someone sent reuses the golden's run id with a command of its own, and is unpacked here.
    const sent = mkdtempSync(join(tmpdir(), 'sl-sent-'));
    cpSync(golden, sent, { recursive: true });
    editPack(sent, (m) => (m.runs[0].command.argv = ['sh', '-c', 'echo owned > PWNED.txt; node agent.mjs A-1042']));
    const store = Store.open(':memory:');
    unpackRun(store, sent);
    expect(importGolden(store, golden).command.argv).toEqual(['node', 'agent.mjs', 'A-1042']);

    // A golden copied and given another ticket replays the original's recording with its own command,
    // in a store that holds the original, as it does alone.
    const copy = join(project, 'goldens', 'ticket-1077');
    cpSync(golden, copy, { recursive: true });
    editPack(copy, (m) => (m.runs[0].command.argv = ['node', 'agent.mjs', 'A-1077']));
    expect(importGolden(store, copy)).toMatchObject({ runId: run.runId, command: { argv: ['node', 'agent.mjs', 'A-1077'] } });
    // The store's copy itself is left as it was.
    expect(store.getRun(run.runId)!.command.argv[0]).toBe('sh');
    store.close();
    rmSync(sent, { recursive: true, force: true });
  });

  it('fails when the calls differ, naming where the store got its copy', () => {
    const source = Store.open(':memory:');
    const run = recordTicket(source, 'A-1042');
    const golden = join(project, 'goldens', 'ticket-calls');
    packRun(source, run.runId, golden);
    source.close();
    // A pull request's folder held the run with another answer, and was pulled with --include-pr.
    const store = Store.open(':memory:');
    store.importRun({ ...run, meta: { imported: { at: 1, from: 's3://team/support-agent/pr/12', pr: '12' } } });
    const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'a'.repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'm', messages: [{ role: 'user', content: 'ticket A-1042' }] }), meta: {}, at: 1 });
    store.appendCallEnd(id, { runId: run.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from('event: message_start\ndata: {"text":"all good"}\n\n')), outcome: 'ok', meta: { status: 200 }, at: 2 });
    expect(() => importGolden(store, golden)).toThrow(`the store already holds another recording under this golden's run id ${run.runId.slice(0, 10)} (pulled from pull request 12's folder in the team store), and its calls differ from the pack's`);
    store.close();
  });

  it('replays the run recorded here when the golden is its redacted pack', () => {
    const store = Store.open(':memory:');
    const run = recordTicket(store, 'A-1042');
    const golden = join(project, 'goldens', 'ticket-redacted');
    packRun(store, run.runId, golden, { redact: [{ pattern: 'email', replace: '<EMAIL>' }] });
    expect(readFileSync(join(golden, 'run.json'), 'utf8')).toContain('<EMAIL>');
    expect(importGolden(store, golden)).toEqual(run);
    // Packed again with one more rule, on top of a store that holds a redacted copy: the same recording.
    const other = Store.open(':memory:');
    unpackRun(other, golden);
    const again = join(project, 'goldens', 'ticket-redacted-more');
    packRun(other, run.runId, again, { redact: [{ pattern: '/refund A-\\d+/', replace: '<ANSWER>' }] });
    expect(importGolden(other, again).runId).toBe(run.runId);
    expect(() => importGolden(Store.open(':memory:'), again)).not.toThrow();
    store.close();
    other.close();
  });

  it('replays an older pack of the run over a copy unpacked from a newer pack with more rules', () => {
    const TICKET = { pattern: '/A-\\d+/', replace: '<TICKET>' };
    const EMAIL = { pattern: 'email', replace: '<EMAIL>' };
    /** The golden as an older checkout holds it (packed with `before`), and as packed again into its folder with `after`. */
    const packedTwice = (name: string, ticket: string, before: Array<typeof EMAIL>, after: Array<typeof EMAIL>) => {
      const source = Store.open(':memory:');
      const run = recordTicket(source, ticket);
      const golden = join(project, 'goldens', name);
      packRun(source, run.runId, golden, { redact: before });
      const older = mkdtempSync(join(tmpdir(), 'sl-older-'));
      cpSync(golden, older, { recursive: true });
      packRun(source, run.runId, golden, { redact: after });
      source.close();
      return { run, golden, older };
    };
    const store = Store.open(':memory:');
    const dirs: string[] = [];
    // A teammate tests the newer pack first, which keeps its redacted copy in the store, then the older one.
    for (const [name, ticket, before] of [['ticket-older', 'A-1042', []], ['ticket-older-ruled', 'A-2001', [TICKET]]] as const) {
      const { run, golden, older } = packedTwice(name, ticket, [...before], [...before, EMAIL]);
      dirs.push(older);
      expect(importGolden(store, golden).meta?.redactions).toEqual([...before, EMAIL]);
      expect(importGolden(store, older)).toMatchObject({ runId: run.runId, command: { argv: ['node', 'agent.mjs', ticket] } });
    }

    // An older pack whose calls are another recording is still refused.
    const { run, golden } = packedTwice('ticket-older-other', 'A-3003', [], [EMAIL]);
    importGolden(store, golden);
    const elsewhere = Store.open(':memory:');
    elsewhere.importRun({ ...run, meta: {} });
    const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'a'.repeat(64), occurrence: 1 };
    elsewhere.appendCallStart({ runId: run.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(elsewhere, { model: 'm', system: 'Support agent. Escalate to ops@northwind.example.', messages: [{ role: 'user', content: 'ticket A-3003' }] }), meta: { provider: 'anthropic' }, at: 1 });
    elsewhere.appendCallEnd(id, { runId: run.runId, callNo: 1, attempt: 0, responseRef: elsewhere.putBlob(Buffer.from('event: message_start\ndata: {"text":"all good"}\n\n')), outcome: 'ok', meta: { status: 200 }, at: 2 });
    const another = mkdtempSync(join(tmpdir(), 'sl-another-'));
    dirs.push(another);
    packRun(elsewhere, run.runId, another);
    elsewhere.close();
    expect(() => importGolden(store, another)).toThrow("and its calls differ from the pack's");
    store.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
});
