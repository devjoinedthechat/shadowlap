import { describe, expect, it } from 'vitest';
import { askedTools, callDetail, resultLine, type CallLike } from '../ui/run/calls.js';
import { attemptBundle, type BundleAttempt } from '../ui/run/forks.js';
import { bisectBlocked, bisectCopy, blameCommand, blameSource, readExpect } from '../ui/run/offers.js';
import { defaultPackFolder, shareItems, shareNote } from '../ui/run/share.js';
import type { BisectOffer, RunOffers } from '../ui/types.js';

// The run page's Share menu, Run blame, Find the commit, the Calls view's detail and the Forks view's
// bundles, as the page words them from what the server offers.

const RUN = '01M50J6C69T0S34ZZX4WBXJKD1';

describe('the Share menu', () => {
  const team: RunOffers['team'] = { store: 'bucket/team', state: 'only-here' };
  const all = () => true;

  it('lists the share link first with a team store, then HTML and each copy the server can make', () => {
    expect(shareItems({ can: all, team }).map((i) => i.key)).toEqual(['link', 'html', 'pack', 'dataset', 'otel', 'har']);
    expect(shareItems({ can: all, team: null }).map((i) => i.key)).toEqual(['html', 'pack', 'dataset', 'otel', 'har']);
    // A server without the jobs still downloads the HTML file, and packs through the run's own action.
    expect(shareItems({ can: (k) => k === 'pack', team }).map((i) => i.key)).toEqual(['html', 'pack']);
    expect(shareItems({ can: all, team }).find((i) => i.key === 'otel')).toEqual({ key: 'otel', label: 'OpenTelemetry trace', note: 'export otel · a span per call, for the tools you already use' });
  });

  it('says how many redaction rules each copy applies, and when a trace takes fewer', () => {
    const copies = (total: number, otel: number) => ({ copies: { total, pathless: otel, formats: [{ id: 'html' as const, applies: 'all' as const, rules: total }, { id: 'otel' as const, applies: 'attributes' as const, rules: otel }] } });
    expect(shareNote(copies(3, 3), null)).toEqual({ text: '3 redaction rules apply to every copy.', link: 'Settings' });
    expect(shareNote(copies(2, 1), null).text).toBe('2 redaction rules apply to every copy, 1 to a trace.');
    expect(shareNote(copies(1, 0), null).text).toBe('1 redaction rule applies to every copy, none to a trace.');
    expect(shareNote(copies(0, 0), null)).toEqual({ text: 'No redaction rules yet: a copy holds what was recorded.', link: 'Add some' });
    // An older server: its count, or the config's rules in words.
    expect(shareNote(null, 2).text).toBe('2 redaction rules apply to every copy.');
    expect(shareNote(null, null).text).toBe('The redaction rules in shadowlap.config.json apply to every copy.');
    expect(defaultPackFolder(RUN)).toBe('.shadowlap/exports/01m50j6c69');
  });
});

describe('Run blame and Find the commit', () => {
  it('shows the blame it runs, with the check, and reads a check typed in', () => {
    expect(blameCommand(RUN, { tools: { send_email: 0 } })).toBe(`shadowlap blame 01M50J6C69 --expect '{"tools":{"send_email":0}}'`);
    expect(blameCommand(RUN, null)).toBe('shadowlap blame 01M50J6C69');
    expect(readExpect('{"tools":{"send_email":0}}')).toEqual({ expect: { tools: { send_email: 0 } } });
    expect(readExpect('')).toHaveProperty('error');
    expect(readExpect('[1]')).toHaveProperty('error');
    expect(readExpect('{oops')).toHaveProperty('error');
    expect(blameSource({ from: 'golden', expect: {}, failed: [] })).toBe('its golden’s checks in shadowlap.config.json');
    expect(blameSource({ from: 'exit', expect: null, failed: [] })).toBe('the exit status: a passing run exits 0');
  });

  const offer = (over: Partial<BisectOffer> = {}): BisectOffer => ({ target: { kind: 'run', runId: RUN }, failed: true, good: 'c91d0f4', bad: 'd2e8a1f', revisions: [{ rev: 'c91d0f4', at: 1, runs: 3, failed: 0 }, { rev: 'a7b3c2e', at: 0, runs: 2, failed: 1 }], fork: false, live: false, unavailable: null, args: null, ...over });

  it('asks for a commit where it still worked, from the revisions its runs were made at', () => {
    const c = bisectCopy(RUN, offer());
    expect(c.title).toBe('Find the commit that broke 01M50J6C69');
    expect(c.text).toBe('Replays the run at commits between a good one and d2e8a1f, halving each time, and names the first where it fails. Replays are free, so this costs no tokens.');
    expect(c.choices).toEqual([
      { value: 'c91d0f4', label: 'c91d0f4 · 3 runs' },
      { value: 'a7b3c2e', label: 'a7b3c2e · 2 runs, 1 failed' },
    ]);
    expect(c.initial).toBe('c91d0f4');
    expect(c.command('a7b3c2e')).toBe('shadowlap bisect 01M50J6C69 --good a7b3c2e --bad d2e8a1f');
    // A run that failed on its own replays live past where it differs: it says so, and forks.
    const live = bisectCopy(RUN, offer({ fork: true, live: true, bad: null, revisions: [] }));
    expect(live.text).toMatch(/and HEAD, .* this costs tokens\.$/);
    expect(live.choices).toEqual([{ value: 'c91d0f4', label: 'c91d0f4 · where it last passed' }]);
    expect(live.command('…')).toBe('shadowlap bisect 01M50J6C69 --good … --fork');
    // A golden's replay bisects the golden.
    expect(bisectCopy(RUN, offer({ target: { kind: 'golden', golden: 'goldens/research' } })).command('x1')).toBe('shadowlap bisect goldens/research --good x1 --bad d2e8a1f');
  });

  it('says why it can’t start: the server’s reason, or a dashboard without the job', () => {
    expect(bisectBlocked(RUN, offer({ unavailable: 'this run is still recording' }), true)).toBe('this run is still recording');
    expect(bisectBlocked(RUN, offer(), false)).toBe('This dashboard can’t run it: shadowlap bisect 01M50J6C69 --good <commit>');
    expect(bisectBlocked(RUN, null, true)).toBeNull();
  });
});

describe('the Calls view’s detail', () => {
  const call = (callNo: number, kind: string, over: Partial<CallLike> & { requestedBy?: number | null } = {}): CallLike & { requestedBy?: number | null } => ({
    callNo,
    kind,
    name: kind === 'api' ? 'POST /v1/messages' : kind === 'clock' ? 'now' : 'search_web',
    origin: 'live',
    effect: kind === 'tool' ? 'read' : null,
    outcome: 'ok',
    status: null,
    latencyMs: 10,
    model: kind === 'api' ? 'sonnet-5' : null,
    stopReason: kind === 'api' ? 'tool_use' : null,
    usage: null,
    detail: kind === 'clock' ? 'start' : '{"q":"x"}',
    attempts: 0,
    replayedFrom: null,
    error: null,
    startedAt: callNo,
    endedAt: callNo + 1,
    ttftMs: null,
    scope: null,
    ...over,
  });

  it('names the tools a model call asked for, as the run made them, else its stop reason', () => {
    const calls = [call(3, 'api'), call(4, 'tool', { requestedBy: 3 }), call(5, 'tool', { requestedBy: 3, name: 'read_file' }), call(6, 'tool', { requestedBy: 3 }), call(7, 'api', { stopReason: 'end_turn' })];
    const asked = askedTools(calls);
    expect(asked.get(3)).toBe('search_web ×2, read_file');
    expect(callDetail(calls[0]!, asked.get(3) ?? null)).toEqual({ text: '→ search_web ×2, read_file', err: false });
    expect(callDetail(calls[4]!, asked.get(7) ?? null)).toEqual({ text: 'end_turn', err: false });
    // A server that doesn't say which call asked: the model and the stop reason, as before.
    expect(callDetail(calls[4]!)).toEqual({ text: 'sonnet-5 · end_turn', err: false });
  });

  it('shows the value a clock read or a random value gave beside it, with no result line', () => {
    const now = call(1, 'clock', { resultShort: '1792094173884' });
    expect(callDetail(now)).toEqual({ text: '1792094173884', err: false });
    expect(resultLine(now)).toBeNull();
    expect(callDetail(call(1, 'clock'))).toEqual({ text: 'start', err: false });
  });
});

describe('the Forks view’s bundles', () => {
  const attempt = (n: number, over: Partial<BundleAttempt> = {}): BundleAttempt => ({ runId: `01M50J6F6${n}AAAAAAAAAAAAAAAA`, status: 'completed', divergence: { callNo: 28 }, spent: 0.01, startedAt: n, repeat: { group: 'g', attempt: n, of: 2 }, checks: { passed: 1, total: 1 }, ...over });

  it('bundles a blame probe’s attempts, links them to the fix’s blame step, and marks the probe blame settled on', () => {
    const probe = (n: number, passed: boolean) => attempt(n, { probe: { of: RUN, callNo: 28, passed }, checks: { passed: passed ? 1 : 0, total: 1 } });
    const b = attemptBundle([probe(2, false), probe(1, true)], { blamedAt: 28, fix: { href: '#/fixes/fx-1/blame' } });
    expect(b).toMatchObject({ kind: 'blame', title: 'blame · probe #28', line: '2 attempts, 1 passed · ≈$0.020', blamed: true, glyph: 'blame', href: '#/fixes/fx-1/blame' });
    expect(b.attempts.map((a) => [a.text, a.ok])).toEqual([
      ['01M50J6F61 · passed', true],
      ['01M50J6F62 · check failed', false],
    ]);
    expect(attemptBundle([probe(1, true)], { blamedAt: 30, fix: null })).toMatchObject({ blamed: false, href: null });
  });

  it('bundles a verify’s attempts with its verdict, and a --repeat as before', () => {
    const v = (n: number, passed: boolean, verdict: string | null) => attempt(n, { verify: { role: 'holdout', passed }, fix: verdict ? { href: '#/fixes/fx-1/verify/v-1', verdict } : null, status: passed ? 'completed' : 'failed', checks: null });
    expect(attemptBundle([v(1, true, 'rejected'), v(2, false, null)], null)).toMatchObject({ kind: 'verify', title: 'verify · held-out', glyph: 'fixbad', href: '#/fixes/fx-1/verify/v-1', line: '2 attempts, 1 passed · ≈$0.020' });
    expect(attemptBundle([v(1, true, null)], null)).toMatchObject({ glyph: 'fixok' });
    expect(attemptBundle([attempt(1), attempt(2)], null)).toMatchObject({ kind: 'repeat', title: 'replay --repeat 2', glyph: 'fork' });
  });
});
