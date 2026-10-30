import { describe, expect, it } from 'vitest';
import { normalizeAction, normalizeActions, normalizeMeta, normalizeRunDetail, normalizeRuns, sentence } from '../ui/normalize.js';
import { copyAmbiguous, copyRunId, exportStartRun, familyLine, isAttempt, isFailed, repeatBundle, runOutcome, runType, type RepeatAttempt, type RunLike } from '../ui/runs.js';
import type { ActionItem, RunDetail, RunListItem } from '../ui/types.js';

// The dashboard reads what other parts of the API send in their own shapes: these turn each into
// the one the views read, and leave a server that sends none of it as it was.

const row = (runId: string, over: Partial<RunListItem> = {}): RunListItem => ({
  runId,
  parentRunId: null,
  depth: 0,
  mode: 'record',
  status: 'completed',
  label: 'recording',
  divergence: null,
  command: 'python agent.py',
  codeVersion: null,
  startedAt: 1_000,
  endedAt: 2_000,
  calls: 30,
  spent: 0.04,
  saved: 0,
  captured: 0,
  imported: false,
  covers: null,
  source: null,
  labels: [],
  ...over,
});

const detail = (over: Record<string, unknown> = {}, divergence: { callNo: number } | null = null): RunDetail =>
  ({ run: { runId: '01K5CQ4P2R', divergence, meta: {} }, calls: [], actions: [], ...over }) as unknown as RunDetail;

describe('meta', () => {
  it('says why a dashboard is read-only as a sentence, and keeps only well-formed live runs and job kinds', () => {
    const m = normalizeMeta({
      version: '0.9.0',
      dbPath: null,
      actions: false,
      readOnly: true,
      readOnlyReason: 'this dashboard is read-only (started with --read-only): it shows runs and changes nothing',
      live: [{ runId: '01K5CQ6L0P', calls: 9 }, { calls: 3 }, { runId: '01K5CQ6L0Q', calls: 4, events: 7 }] as never,
      jobKinds: ['action', 7, 'blame'] as never,
    });
    expect(m.readOnlyReason).toBe('This dashboard is read-only (started with --read-only): it shows runs and changes nothing.');
    expect(m.live).toEqual([
      { runId: '01K5CQ6L0P', calls: 9 },
      { runId: '01K5CQ6L0Q', calls: 4, events: 7 },
    ]);
    expect(m.jobKinds).toEqual(['action', 'blame']);
    expect(normalizeMeta({ version: null, dbPath: null, actions: true }).readOnlyReason).toBeNull();
    expect(sentence('ends already.')).toBe('Ends already.');
  });
});

describe('the run list', () => {
  it('reads where blame lost a run from lostAt, as the Runs table’s rows say it', () => {
    const [lost, plain] = normalizeRuns([row('01A', { lostAt: 17 }), row('01B', { lostAt: null })]);
    expect(lost.blame).toEqual({ callNo: 17 });
    expect(runOutcome(lost)).toEqual({ tone: 'err', text: 'lost at #17' });
    expect(isFailed(lost)).toBe(true);
    expect(plain.blame).toBeUndefined();
  });

  it('bundles an attempt under its run, and lists one whose run is gone like any run', () => {
    const list = normalizeRuns([row('01REC'), row('01TRY', { attemptOf: '01REC', attemptKind: 'repeat' }), row('01ORPHAN', { attemptOf: '01GONE', attemptKind: 'probe' })]);
    expect(list.map((r) => isAttempt(r))).toEqual([false, true, false]);
  });

  it('takes the server’s kind and outcome when it classifies runs itself, and works them out otherwise', () => {
    const server: RunLike = { ...row('01P', { mode: 'record' }), kind: 'pack', outcome: { kind: 'passed', checks: 2 }, failed: false };
    expect(runType(server)).toBe('recording');
    expect(runOutcome(server)).toEqual({ tone: 'ok', text: '2 checks passed' });
    expect(runOutcome({ ...row('01Q'), outcome: { kind: 'check-failed', check: 'send_email called 0×' } })).toEqual({ tone: 'err', text: 'check failed' });
    expect(runOutcome({ ...row('01R'), outcome: { kind: 'diverged', callNo: 1 } })).toEqual({ tone: 'err', text: 'diverged at #1' });
    expect(runOutcome({ ...row('01S'), outcome: { kind: 'none' } })).toEqual({ tone: 'n', text: '—' });
    expect(isFailed({ ...row('01T', { status: 'failed' }), failed: false })).toBe(false);
    // Without them: today's fields.
    expect(runType(row('01U', { mode: 'replay', parentRunId: '01P', divergence: { callNo: 17, type: 'request_changed' } }))).toBe('fork');
    expect(runOutcome(row('01V', { status: 'failed' }))).toEqual({ tone: 'err', text: 'failed' });
  });
});

describe('a run', () => {
  it('reads cache misses that count sentAgain, as the run page’s read model sends them', () => {
    const d = normalizeRunDetail(detail({ cache: { readShare: null, readShareAll: 0.4, sentAgain: 8_000, misses: [{ callNo: 17, sentAgain: 8_000, previousCallNo: 15, scope: null, conversation: 1 }, { callNo: 'x' }] } }));
    expect(d.cache).toEqual({ readShare: null, misses: [{ callNo: 17, tokens: 8_000, previousCallNo: 15, scope: null }] });
  });

  it('reads unrecorded hosts as objects or names, and drops an empty list', () => {
    const d = normalizeRunDetail(detail({ notRecorded: { hosts: [{ target: 'api.stripe.com:443', count: 3, action: 'blocked' }, 'hooks.slack.com:443', { count: 1 }], tools: ['send_sms', 4] } }));
    expect(d.notRecorded).toEqual({
      hosts: [
        { target: 'api.stripe.com:443', count: 3, action: 'blocked' },
        { target: 'hooks.slack.com:443', count: null, action: null },
      ],
      tools: ['send_sms'],
    });
    expect(normalizeRunDetail(detail({ notRecorded: { hosts: [], tools: [] } })).notRecorded).toBeNull();
  });

  it('reads how many attempts deleting the run takes with it, as a count or not at all', () => {
    expect(normalizeRunDetail(detail({ attempts: 6 })).attempts).toBe(6);
    expect('attempts' in normalizeRunDetail(detail({ attempts: '6' }))).toBe(false);
    expect('attempts' in normalizeRunDetail(detail({ attempts: -1 }))).toBe(false);
    expect(normalizeRunDetail(detail({})).attempts).toBeUndefined();
  });

  it('places a rescue that names no call where the fork left, and keeps a blame that placed the failure nowhere', () => {
    const d = normalizeRunDetail(detail({ rescuedBy: { runId: '01K5CQ4N7G', callNo: null }, blame: { outcome: 'unrescuable', callNo: null, modelCall: null, confidence: 'low', rescuedRunId: null, scope: null, at: 1 } }, { callNo: 5 }));
    expect(d.rescuedBy).toEqual({ runId: '01K5CQ4N7G', callNo: 5 });
    expect(d.blame).toEqual({ callNo: null, range: null, modelCall: null, confidence: 'low', rescuedRunId: null, scope: null, outcome: 'unrescuable', short: null });
  });

  it('reads the fix a run belongs to as the brief has it, or as the fixes read model says how the run takes part', () => {
    expect(normalizeRunDetail(detail({ fix: { id: 'fx-12', status: 'verified', title: 'Escalate refunds above the limit' } })).fix).toEqual({ id: 'fx-12', status: 'verified', title: 'Escalate refunds above the limit', href: null });

    // A failing run of an open fix: the fix, and its blame with what asking again did.
    const failing = normalizeRunDetail(
      detail({
        fix: {
          role: 'failing',
          fix: { fixId: 'fx-7', href: '#/fixes/fx-7', title: 'Confirmation email sent twice', status: 'open', label: 'double-email', check: 'send_email called once' },
          blame: { blameId: 'bl-1', at: 1, outcome: 'blamed', lostAt: 9, step: 3, steps: 7, confidence: 'high', rescuedRunId: '01K5CQ5X1Y', short: 'asked again, it calls escalate instead', href: '#/fixes/fx-7/blame' },
          probe: null,
          verify: null,
        },
      }),
    );
    expect(failing.fix).toEqual({ id: 'fx-7', status: 'open', title: 'Confirmation email sent twice', href: '#/fixes/fx-7', check: 'send_email called once' });
    expect(failing.fixRole).toBe('failing');
    expect(failing.blame).toEqual({ callNo: 9, range: null, modelCall: { k: 3, m: 7 }, confidence: 'high', rescuedRunId: '01K5CQ5X1Y', scope: null, outcome: 'blamed', short: 'asked again, it calls escalate instead' });

    // The run page's own blame wins, and the fix adds what asking again did.
    const both = normalizeRunDetail(detail({ blame: { outcome: 'blamed', callNo: 9, modelCall: { k: 3, m: 8 }, confidence: 'high', rescuedRunId: null, scope: 'agent', at: 1 }, fix: { role: 'failing', fix: null, blame: { lostAt: 9, short: 'asked again, it calls escalate instead' } } }));
    expect(both.blame).toMatchObject({ callNo: 9, modelCall: { k: 3, m: 8 }, scope: 'agent', short: 'asked again, it calls escalate instead' });

    // A probe's blame is the blame of the run it came from, not this run's; a failure never blamed may come with a check.
    const probe = normalizeRunDetail(detail({ fix: { role: 'probe', fix: { fixId: 'fx-7', title: 'x', status: 'open' }, blame: { lostAt: 9 }, probe: { of: '01A', callNo: 9, passed: true, blamed: true } } }));
    expect(probe.blame).toBeUndefined();
    expect(probe.fix?.id).toBe('fx-7');
    const unblamed = normalizeRunDetail(detail({ fix: { role: 'unblamed', fix: null, blame: null, probe: null, verify: null, expect: { tools: { send_email: 1 } } } }));
    expect(unblamed).toMatchObject({ fix: null, fixRole: 'unblamed', blameExpect: { tools: { send_email: 1 } } });
    expect(normalizeRunDetail(detail({ fix: { role: 'something new' } })).fix).toBeNull();
  });

  it('keeps checks with their counts and the flag a fork ran with, whatever call it names', () => {
    const d = normalizeRunDetail(detail({ checks: [{ label: 'issue_refund never called', ok: true, detail: null, count: 5, of: 5 }, { ok: true }], intervention: { flag: '--fail-at', value: '19=529', callNo: null } }));
    expect(d.checks).toEqual([{ label: 'issue_refund never called', ok: true, count: 5, of: 5 }]);
    expect(d.intervention).toEqual({ flag: '--fail-at', value: '19=529', callNo: null });
  });

  it('leaves a run from a server that sends none of it as it was', () => {
    const d = normalizeRunDetail(detail());
    expect(d).not.toHaveProperty('cache');
    expect(d).not.toHaveProperty('notRecorded');
    expect(d).not.toHaveProperty('blame');
    expect(d.actions).toEqual([]);
  });
});

describe('actions', () => {
  const action = (over: Partial<ActionItem> & Record<string, unknown>): ActionItem => ({ key: 'i', label: 'Inject an instruction', opensRun: true, prompt: null, disabled: null, ...over });

  it('drops empty flags and hints, keeps a null group (a place of its own) and well-formed choices', () => {
    expect(normalizeAction({ ...action({ group: null }), flag: null, hint: null } as never)).toEqual({ key: 'i', label: 'Inject an instruction', opensRun: true, prompt: null, disabled: null, group: null });
    const t = normalizeAction(action({ key: 't', flag: '--fail-at 16=timeout', group: 'call', prompt: { label: 'How it fails:', initial: 'timeout', choices: [{ value: 'timeout', label: 'timeout' }, { value: 500 }] as never } }));
    expect(t.prompt).toEqual({ label: 'How it fails:', initial: 'timeout', choices: [{ value: 'timeout', label: 'timeout' }] });
    expect(t.flag).toBe('--fail-at 16=timeout');
    // Today's server sends neither: the menu sorts the actions itself.
    expect(normalizeAction(action({}))).not.toHaveProperty('group');
    expect(normalizeActions([action({}), { key: 3 } as never, null as never])).toHaveLength(1);
  });
});

describe('an exported copy', () => {
  const runs = [
    { runId: '01ROOT', parentRunId: null },
    { runId: '01FORK', parentRunId: '01ROOT' },
    { runId: '01FORKFORK', parentRunId: '01FORK' },
  ];

  it('opens on the run that was shared, in either order a copy lists its runs', () => {
    // The dashboard's Share lists the ancestors first; `export html --lineage` lists the run first.
    expect(exportStartRun(['01ROOT', '01FORK', '01FORKFORK'], runs)).toBe('01FORKFORK');
    expect(exportStartRun(['01FORKFORK', '01ROOT', '01FORK'], runs)).toBe('01FORKFORK');
    expect(exportStartRun(['01ROOT'], runs)).toBe('01ROOT');
  });

  it('opens on the first of several unrelated runs, and on nothing when it holds none', () => {
    expect(exportStartRun(['01A', '01B'], [{ runId: '01A', parentRunId: null }, { runId: '01B', parentRunId: null }])).toBe('01A');
    expect(exportStartRun([], [])).toBeNull();
  });

  it('finds a run by a unique prefix of its id, as the dashboard does, and nothing for one it doesn’t hold', () => {
    const ids = ['01M5305KSBQ7H3W2Y9XPN4TE0V', '01M5305ZT3A1B2C3D4E5F6G7H8', '01M5305ZYQA1B2C3D4E5F6G7H8'];
    expect(copyRunId(ids, '01M5305KSB')).toBe(ids[0]);
    expect(copyRunId(ids, '01m5305ksb')).toBe(ids[0]);
    expect(copyRunId(ids, ids[1])).toBe(ids[1]);
    // Two runs start 01M5305Z, and none 01M6: each comes back as it was, and opens nothing.
    expect(copyRunId(ids, '01M5305Z')).toBe('01M5305Z');
    expect(copyRunId(ids, '01M6')).toBe('01M6');
    expect(copyRunId(ids, '../01M5305KSB')).toBe('../01M5305KSB');
    // The copy says a prefix of several of its runs matches several, as the server does, and a missing one isn't there.
    expect(copyAmbiguous(ids, '01M5305Z')).toBe(true);
    expect(copyAmbiguous(ids, '01m5305z')).toBe(true);
    expect(copyAmbiguous(ids, '01M5305KSB')).toBe(false);
    expect(copyAmbiguous(ids, '01M6')).toBe(false);
    expect(copyAmbiguous(ids, '../01M5305Z')).toBe(false);
  });
});

describe('the Forks view’s lines', () => {
  const base = { ...row('01K5CQ4R1T'), origins: null } as RunLike;
  it('says what happened in each run of the family', () => {
    expect(familyLine({ ...base, mode: 'replay', parentRunId: '01K5CQ4N7G', divergence: { callNo: 17, type: 'request_changed' }, origins: 'rrrrrrrrrrrrrrrrlllllllllllllb', spent: 0.031 })).toBe('fork @17 · 16 replayed · 13 live · 1 blocked · ≈$0.031');
    expect(familyLine({ ...base, mode: 'replay', parentRunId: '01K5CQ4N7G', origins: 'r'.repeat(30) })).toBe('clean replay · 30/30 · 0 upstream');
    expect(familyLine({ ...base, status: 'running', calls: 9 })).toBe('recording · 9 calls so far');
    expect(familyLine({ ...base, source: 'traffic.har', covers: ['api'], captured: 0.12 })).toBe('capture · 30 calls · $0.12 as captured');
    expect(familyLine({ ...base, mode: 'replay', parentRunId: '01K5CQ4N7G', divergence: { callNo: 4, type: 'forced' } })).toBe('fork @4 · 30 calls · ≈$0.040');
  });

  it('bundles the attempts of one replay --repeat as the design words them', () => {
    const attempt = (n: number, over: Partial<RepeatAttempt> = {}): RepeatAttempt => ({ runId: `01K5CQ5G1${n}0000000000000000`, status: 'completed', divergence: { callNo: 17 }, spent: 0.03, startedAt: n, repeat: { attempt: n, of: 3 }, checks: null, ...over });
    const b = repeatBundle([attempt(2), attempt(1), attempt(3, { status: 'failed', divergence: { callNo: 19 } })]);
    expect(b.title).toBe('replay --repeat 3');
    expect(b.line).toBe('forked 3 attempts, 2 passed · ≈$0.090');
    expect(b.attempts).toEqual([
      { runId: '01K5CQ5G110000000000000000', text: '01K5CQ5G11 · passed', ok: true },
      { runId: '01K5CQ5G120000000000000000', text: '01K5CQ5G12 · passed', ok: true },
      { runId: '01K5CQ5G130000000000000000', text: '01K5CQ5G13 · failed · forked at #19', ok: false },
    ]);
    // A repeat of a recording replays it: nothing forked; checks decide when there are some.
    const clean = repeatBundle([attempt(1, { divergence: null, spent: 0, checks: { passed: 2, total: 2 } }), attempt(2, { divergence: null, spent: 0, checks: { passed: 1, total: 2 } })]);
    expect(clean.line).toBe('2 attempts, 1 passed');
    expect(clean.attempts.map((a) => a.text)).toEqual(['01K5CQ5G11 · checks 2 of 2', '01K5CQ5G12 · checks 1 of 2']);
  });
});
