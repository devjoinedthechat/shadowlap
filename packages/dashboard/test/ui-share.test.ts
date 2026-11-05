import { describe, expect, it } from 'vitest';
import { divergenceButtons, } from '../ui/goldens.js';
import { updatePlan } from '../ui/update-plan.js';
import { askedTools, callDetail, resultLine, type CallLike } from '../ui/run/calls.js';
import { bisectBlocked, bisectCopy, bisectLabel, blameOfferFor, blameSource, blameTitle, divergedActions, goldenName, updateGoldenCopy, updatesAfterRules, type BlameFacts } from '../ui/run/offers.js';
import { canPush, defaultPackFolder, htmlCopyVia, pushTitle, shareCommand, shareDialog, sharedLink, shareItemOff, shareItems, shareNote, shareWhy, STILL_RECORDING } from '../ui/run/share.js';
import type { BisectOffer, DivergenceView, RunOffers, TestBannerOffer, TestsView } from '../ui/types.js';

// The run page's Share menu, Run blame, Find the commit and the Calls view's detail, as the page words
// them from what the server offers.

const RUN = '01M50J6C69T0S34ZZX4WBXJKD1';

describe('the Share menu', () => {
  const team: RunOffers['team'] = { store: 'bucket/team', state: 'only-here' };
  const all = () => true;

  it('lists the share link first with a team store, then HTML and each copy the server can make', () => {
    expect(shareItems({ can: all, team }).map((i) => i.key)).toEqual(['link', 'html', 'pack', 'dataset', 'otel', 'har']);
    expect(shareItems({ can: all, team: null }).map((i) => i.key)).toEqual(['html', 'pack', 'dataset', 'otel', 'har']);
    // A server without the jobs still downloads the HTML file, and packs through the run's own action.
    expect(shareItems({ can: (k) => k === 'pack', team }).map((i) => i.key)).toEqual(['html', 'pack']);
    // A row is one line: its words and what it runs; what it is for is on its hover card, with its command.
    const items = shareItems({ can: all, team });
    const otel = items.find((i) => i.key === 'otel')!;
    expect(otel).toEqual({ key: 'otel', label: 'OpenTelemetry trace…', flag: 'export otel', why: 'A span per call, for the tools you already use' });
    // Its whole command: what its job runs, with the file or folder the job writes; a row that asks first says the rest in its dialog.
    expect(Object.fromEntries(items.map((i) => [i.key, shareCommand(i, RUN)]))).toEqual({
      link: '$ shadowlap share 01M50J6C69 --lineage',
      html: '$ shadowlap export html 01M50J6C69 .shadowlap/exports/shadowlap-01m50j6c69.html --lineage',
      pack: '$ shadowlap pack 01M50J6C69 .shadowlap/exports/01m50j6c69',
      dataset: '$ shadowlap export dataset 01M50J6C69',
      otel: '$ shadowlap export otel 01M50J6C69',
      har: '$ shadowlap export har 01M50J6C69 .shadowlap/exports/01m50j6c69.har',
    });
    // The bucket in a clause of its own: the days belong to the link.
    expect(shareWhy(items[0], team)).toBe('A redacted report in your bucket, bucket/team; the link expires in 7 days');
    expect(shareWhy(items[0], null)).toBe('A redacted report in your bucket; the link expires in 7 days');
    expect(shareWhy(otel, team)).toBe(otel.why);
    // Parallel nouns, the copy each makes, an ellipsis on each that asks first.
    expect(shareItems({ can: all, team }).map((i) => i.label)).toEqual(['Share link', 'HTML report', 'Pack…', 'Eval dataset…', 'OpenTelemetry trace…', 'HAR file']);
  });

  it('titles and confirms each copy’s dialog with its action’s verb, and the runs it copies', () => {
    expect(shareDialog('otel', [RUN])).toEqual({ title: 'Export OpenTelemetry trace', ok: 'Export trace' });
    expect(shareDialog('dataset', [RUN])).toEqual({ title: 'Export eval dataset of 01M50J6C69', ok: 'Export dataset' });
    expect(shareDialog('dataset', [RUN, '01M50J6C70T0S34ZZX4WBXJKD1', '01M50J6C71T0S34ZZX4WBXJKD1']).title).toBe('Export eval dataset of 3 runs');
    expect(shareDialog('pack', [RUN])).toEqual({ title: 'Pack 01M50J6C69', ok: 'Pack run' });
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

  const readOnly = 'This dashboard is read-only: it was started with --read-only.';

  it('makes the HTML file as a job where jobs run, and downloads it straight from the server where they don’t', () => {
    expect(htmlCopyVia({ actionsOff: null, hasJob: true })).toBe('job');
    // Read-only: the job would be refused, and reading and copying never stop.
    expect(htmlCopyVia({ actionsOff: readOnly, hasJob: true })).toBe('download');
    // A server without the job.
    expect(htmlCopyVia({ actionsOff: null, hasJob: false })).toBe('download');
    expect(htmlCopyVia({ actionsOff: 'This link has expired.', hasJob: false })).toBe('download');
  });

  it('turns off each copy where it can’t be made, saying why', () => {
    expect(shareItemOff('html', { actionsOff: readOnly, live: false })).toBeNull();
    for (const key of ['link', 'pack', 'dataset', 'otel', 'har'] as const) expect(shareItemOff(key, { actionsOff: readOnly, live: false }), key).toBe(readOnly);
    for (const key of ['link', 'html', 'pack', 'dataset', 'otel', 'har'] as const) {
      expect(shareItemOff(key, { actionsOff: null, live: false }), key).toBeNull();
      // A run still recording: a copy of it would never end.
      expect(shareItemOff(key, { actionsOff: null, live: true }), key).toBe(STILL_RECORDING);
      expect(shareItemOff(key, { actionsOff: readOnly, live: true }), key).toBe(STILL_RECORDING);
    }
  });

  it('offers Push for a run only on this machine, where the server can push', () => {
    const ok = { exported: false, live: false, team, hasPush: true };
    expect(canPush(ok)).toBe(true);
    expect(canPush({ ...ok, hasPush: false })).toBe(false);
    expect(canPush({ ...ok, live: true })).toBe(false);
    expect(canPush({ ...ok, exported: true })).toBe(false);
    expect(canPush({ ...ok, team: null })).toBe(false);
    for (const state of ['queued', 'in-store', 'recording', 'pull-request'] as const) expect(canPush({ ...ok, team: { store: 'bucket/team', state } }), state).toBe(false);
  });
});

describe('the share link a share job made', () => {
  it('offers the link once the job ended well, and only a web address', () => {
    const done = { done: true, code: 0, result: { runId: 'x', url: 'https://bucket.s3.amazonaws.com/shares/x.html?X-Amz-Signature=abc', expiresAt: 1_800_000_000_000 } };
    expect(sharedLink(done)).toEqual({ url: done.result.url, expiresAt: 1_800_000_000_000 });
    expect(sharedLink({ ...done, result: { url: 'http://127.0.0.1:9000/team/x.html' } })).toEqual({ url: 'http://127.0.0.1:9000/team/x.html', expiresAt: null });
    // Not yet, not after a failure, and never anything that isn't a web address.
    expect(sharedLink({ ...done, done: false })).toBeNull();
    expect(sharedLink({ ...done, code: 1 })).toBeNull();
    expect(sharedLink({ ...done, result: null })).toBeNull();
    for (const url of ['javascript:alert(1)', '#/runs', 'file:///etc/passwd', 'https://a b', 42]) expect(sharedLink({ ...done, result: { url } }), String(url)).toBeNull();
  });
});

describe('Run blame and Find the commit', () => {
  it('says on its hover what Run blame does, and where its check comes from', () => {
    // Fixes' button sends it: the job finds the check, asks for one (422) or for a consent (409).
    const golden = { from: 'golden' as const, expect: { tools: { send_email: 1 } }, failed: ['send_email called 1 time'] };
    expect(blameTitle(golden)).toBe('Find the model call where this run was lost, with its golden’s checks in shadowlap.config.json');
    expect(blameTitle({ from: 'ask', failed: ['at most 3 model calls'] })).toBe('Find the model call where this run was lost, once you give the check a passing run meets');
    expect(blameTitle({ from: 'exit', expect: null, failed: [] })).toBe('Find the model call where this run was lost, on its exit status: a passing run exits 0');
    expect(blameSource({ from: 'golden', expect: {}, failed: [] })).toBe('its golden’s checks in shadowlap.config.json');
    expect(blameSource({ from: 'exit', expect: null, failed: [] })).toBe('the exit status: a passing run exits 0');
  });

  it('works Run blame out from the run where the server offers nothing', () => {
    const facts = (over: Partial<BlameFacts> = {}): BlameFacts => ({ blamed: false, capture: false, argv: ['node', 'agent.js'], status: 'failed', failed: [], fixExpect: undefined, ownExpect: undefined, modelCalls: 4, ...over });
    // The server's offer, whatever the run says.
    expect(blameOfferFor({ blame: null }, facts())).toBeNull();
    expect(blameOfferFor({ blame: { from: 'ask', failed: ['x'] } }, facts({ blamed: true }))).toEqual({ from: 'ask', failed: ['x'] });
    // An older server.
    expect(blameOfferFor(null, facts())).toEqual({ from: 'exit', expect: null, failed: [] });
    // Stopped: it never fails again as recorded, so there is nothing to blame, unless it failed a check.
    expect(blameOfferFor(null, facts({ status: 'crashed' }))).toBeNull();
    expect(blameOfferFor(null, facts({ status: 'crashed', failed: ['x'] }))).toEqual({ from: 'ask', failed: ['x'] });
    expect(blameOfferFor(null, facts({ status: 'completed', failed: ['at most 3 model calls'] }))).toEqual({ from: 'ask', failed: ['at most 3 model calls'] });
    expect(blameOfferFor(null, facts({ status: 'completed', failed: ['x'], ownExpect: { tools: { a: 1 } } }))).toEqual({ from: 'run', expect: { tools: { a: 1 } }, failed: ['x'] });
    expect(blameOfferFor(null, facts({ fixExpect: { tools: { b: 0 } } }))).toEqual({ from: 'fix', expect: { tools: { b: 0 } }, failed: [] });
    // Nothing to blame: blamed already, a capture, no command, still recording, no model call, or it passed.
    for (const over of [{ blamed: true }, { capture: true }, { argv: [] }, { status: 'running' }, { modelCalls: 0 }, { status: 'completed' }]) expect(blameOfferFor(null, facts(over)), JSON.stringify(over)).toBeNull();
  });

  const offer = (over: Partial<BisectOffer> = {}): BisectOffer => ({ target: { kind: 'run', runId: RUN }, failed: true, good: 'c91d0f4', bad: 'd2e8a1f', revisions: [{ rev: 'c91d0f4', at: 1, runs: 3, failed: 0 }, { rev: 'a7b3c2e', at: 0, runs: 2, failed: 1 }], fork: false, live: false, unavailable: null, args: null, ...over });

  it('asks for a commit where it still worked, from the revisions its runs were made at', () => {
    const c = bisectCopy(RUN, offer());
    expect([c.title, c.ok]).toEqual(['Find breaking commit for 01M50J6C69', 'Find breaking commit']);
    expect(c.lead).toBe('Finds the first commit that broke the run, from one where it worked.');
    expect(c.facts).toEqual([{ label: 'Bad', value: 'd2e8a1f', quiet: 'the commit the run was recorded at', code: true }]);
    expect(c.cost).toEqual({ price: 'Free', parts: ['bisect replays offline'] });
    expect(c.label).toBe('Good commit');
    expect(c.choices).toEqual([
      { value: 'c91d0f4', subject: null, how: '3 runs of its command · 3 passed' },
      { value: 'a7b3c2e', subject: null, how: '2 runs of its command · 1 of 2 failed' },
    ]);
    expect(c.initial).toBe('c91d0f4');
    expect(c.command('a7b3c2e')).toBe('shadowlap bisect 01M50J6C69 --good a7b3c2e --bad d2e8a1f');
    // A run that failed on its own replays live past where it differs, and forks: one live replay
    // decides each commit, which it says, with what that means for a failure that comes and goes.
    const live = bisectCopy(RUN, offer({ fork: true, live: true, bad: null, revisions: [] }));
    expect(live.cost).toEqual({ price: 'Billed by your provider', parts: ['one live replay each, writes blocked'] });
    expect(live.note).toMatch(/^One live replay decides a commit: a failure that doesn’t happen every time can pass at one that has it/);
    // Where this checkout lacks the run's own commit, the search ends at HEAD.
    expect(live.facts).toEqual([{ label: 'Bad', value: 'HEAD', quiet: 'this checkout doesn’t have its own commit', code: true }]);
    expect(live.choices).toEqual([{ value: 'c91d0f4', subject: null, how: 'where it last passed' }]);
    expect(live.command('…')).toBe('shadowlap bisect 01M50J6C69 --good … --fork');
    // A golden's replay bisects the golden.
    expect(bisectCopy(RUN, offer({ target: { kind: 'golden', golden: 'goldens/research' } })).command('x1')).toBe('shadowlap bisect goldens/research --good x1 --bad d2e8a1f');
    // Its results at a commit are counted by verdict: one that was inconclusive there failed nothing.
    const counted = bisectCopy(RUN, offer({ target: { kind: 'golden', golden: 'goldens/research' }, revisions: [{ rev: 'c91d0f4', at: 1, runs: 3, failed: 0, inconclusive: 1 }, { rev: 'a7b3c2e', at: 0, runs: 2, failed: 1, inconclusive: 1 }] }));
    expect(counted.choices).toEqual([
      { value: 'c91d0f4', subject: null, how: '3 runs of its command · 1 of 3 inconclusive' },
      { value: 'a7b3c2e', subject: null, how: '2 runs of its command · 1 of 2 failed, 1 inconclusive' },
    ]);
  });

  it('names each commit by its subject, and judges a run blame found failing by that check, when the server says', () => {
    const revisions = [{ rev: 'c91d0f4', at: 1, runs: 3, failed: 0, subject: 'Escalate refunds above the limit' }, { rev: 'a7b3c2e', at: 0, runs: 2, failed: 1 }];
    const c = bisectCopy(RUN, { ...offer({ fork: true, live: true, good: null }), revisions, expect: { tools: { send_email: 1 } } });
    expect(c.choices).toEqual([
      { value: 'c91d0f4', subject: 'Escalate refunds above the limit', how: '3 runs of its command · 3 passed' },
      { value: 'a7b3c2e', subject: null, how: '2 runs of its command · 1 of 2 failed' },
    ]);
    expect(c.command('c91d0f4')).toBe(`shadowlap bisect 01M50J6C69 --good c91d0f4 --bad d2e8a1f --expect '{"tools":{"send_email":1}}' --fork`);
  });

  it('looks for what changed a run that passed, not what broke it', () => {
    const passed = offer({ failed: false, good: 'a7b3c2e', bad: null, revisions: [{ rev: 'c91d0f4', at: 0, runs: 3, failed: 0 }] });
    expect(bisectLabel(passed)).toEqual({ label: 'Find commit that changed it…', hint: 'Names the first commit after its own where it does something else' });
    const c = bisectCopy(RUN, passed);
    expect([c.title, c.ok]).toEqual(['Find commit that changed 01M50J6C69', 'Find commit that changed it']);
    expect(c.lead).toBe('Finds the first commit after its own that changed what the run does.');
    expect(c.facts).toEqual([]);
    expect(c.label).toBe('Start from');
    expect(c.initial).toBe('a7b3c2e');
    // A run that failed, or one nothing is known of, looks for what broke it.
    expect(bisectLabel(offer()).label).toBe('Find breaking commit…');
    expect(bisectLabel(null).label).toBe('Find breaking commit…');
    // At HEAD there is nothing after it to search: the server says so, and the item says why.
    expect(bisectBlocked(RUN, { ...passed, unavailable: 'this run passed at a7b3c2e, which is HEAD: there is no later commit to search yet' }, true)).toBe('this run passed at a7b3c2e, which is HEAD: there is no later commit to search yet');
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
    expect(callDetail(calls[0], asked.get(3) ?? null)).toEqual({ text: '→ search_web ×2, read_file', err: false });
    expect(callDetail(calls[4], asked.get(7) ?? null)).toEqual({ text: 'end_turn', err: false });
    // A server that doesn't say which call asked: the model and the stop reason, as before.
    expect(callDetail(calls[4])).toEqual({ text: 'sonnet-5 · end_turn', err: false });
  });

  it('names the tools a model call’s answer asked for when no tool call of the run says so, as in a capture', () => {
    const asking = call(1, 'api', { stopReason: 'tool_use', asks: ['get_ticket'] });
    expect(callDetail(asking)).toEqual({ text: '→ get_ticket', err: false });
    expect(callDetail({ ...asking, asks: ['lookup', 'lookup', 'notify'] }, null)).toEqual({ text: '→ lookup ×2, notify', err: false });
    // The calls that ran win: they count what was made.
    expect(callDetail(asking, 'get_ticket ×2')).toEqual({ text: '→ get_ticket ×2', err: false });
    expect(callDetail({ ...asking, asks: [] }, null)).toEqual({ text: 'tool_use', err: false });
    // An answer known to ask for nothing says how it stopped, as when the run's tool calls say so.
    expect(callDetail({ ...asking, stopReason: 'end_turn', asks: [] })).toEqual({ text: 'end_turn', err: false });
  });

  it('shows the value a clock read or a random value gave beside it, with no result line', () => {
    const now = call(1, 'clock', { resultShort: '1792094173884' });
    expect(callDetail(now)).toEqual({ text: '1792094173884', err: false });
    expect(resultLine(now)).toBeNull();
    expect(callDetail(call(1, 'clock'))).toEqual({ text: 'start', err: false });
  });
});

describe('the diverged test’s actions', () => {
  const test = (over: Partial<TestBannerOffer> = {}): TestBannerOffer =>
    ({
      golden: 'goldens/research',
      session: 's1',
      volatile: { path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', certain: true, normalizer: { path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }, args: [], command: "shadowlap normalize add --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'" },
      normalizerFixes: true,
      maybeReal: false,
      values: { values: [], explainsAll: true, coversAll: true },
      rerun: [],
      update: [],
      normalizeAndTest: [['normalize', 'add'], ['test', 'goldens/research']],
      normalized: false,
      passingRun: null,
      ...over,
    }) as TestBannerOffer;
  const all = { hasNormalizeJob: true, hasUpdateJob: true, action: true, actionsOff: null };
  // refund-in-limit as the demo has it: the request now carries a per-run user id the recording never
  // had, so the rule alone can't make the replay match and the golden is updated after it.
  const ADD = ['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'];
  const added = (over: Partial<TestBannerOffer> = {}) =>
    test({
      golden: 'goldens/refund-in-limit',
      volatile: { path: '$.metadata.user_id', looks: 'a UUID', op: 'added', certain: true, normalizer: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }, args: ADD, command: "shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'" },
      normalizerFixes: false,
      values: { values: [], explainsAll: false, coversAll: false },
      normalizeAndTest: [ADD, ['test', 'goldens/refund-in-limit', '--update']],
      ...over,
    });

  it('adds the normalizer and re-runs the golden in one click when the rule alone makes the replay match, leading when a value made anew is all that changed', () => {
    expect(updatesAfterRules(test())).toBe(false);
    expect(divergedActions({ ...all, test: test() })).toEqual({
      normalizer: { kind: 'job', label: 'Add normalizer and re-run', lead: true, off: null, title: "shadowlap normalize add --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'", asks: null },
      update: true,
    });
    expect(divergedActions({ ...all, test: test({ maybeReal: true }) }).normalizer).toMatchObject({ kind: 'job', label: 'Add normalizer and re-run', lead: false, asks: null });
  });

  it('asks first when the rule alone can’t make the replay match, with the commands the Tests screen’s dialog lists, since the golden is re-recorded live after it', () => {
    expect(updatesAfterRules(added())).toBe(true);
    expect(divergedActions({ ...all, test: added() })).toEqual({
      normalizer: { kind: 'job', label: 'Add normalizer and update', lead: false, off: null, title: "shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'", asks: [ADD, ['test', 'goldens/refund-in-limit', '--update']] },
      update: true,
    });
    // The Tests screen's button for the same steps reads the same, and asks too.
    const d = { normalizeAndTest: added().normalizeAndTest, normalizerFixes: false, maybeReal: false, rulesAdded: false, found: null, missed: null, bisect: null, unreadable: null, volatile: null } as unknown as DivergenceView;
    expect(divergenceButtons(d, () => true).normalize).toEqual({ label: 'Add normalizer and update', lead: false, run: 'normalize-update' });
    // Read-only: the button says why it is off, and never opens the dialog.
    const readOnly = 'This dashboard is read-only: it was started with --read-only.';
    expect(divergedActions({ ...all, actionsOff: readOnly, test: added() }).normalizer).toMatchObject({ kind: 'job', label: 'Add normalizer and update', off: readOnly, title: readOnly });
  });

  it('says the normalizer was added once it is in the config, with the replay that passed since, and offers the update while the rule alone can’t make it match', () => {
    expect(divergedActions({ ...all, test: test({ normalized: true, passingRun: '01M510PASS' }) })).toEqual({ normalizer: { kind: 'added', passingRun: '01M510PASS' }, update: false });
    expect(divergedActions({ ...all, test: test({ normalized: true }) })).toEqual({ normalizer: { kind: 'added', passingRun: null }, update: false });
    // The rule masks the value, but the request also carries what the recording never had: update the golden.
    expect(divergedActions({ ...all, test: added({ normalized: true }) })).toEqual({ normalizer: { kind: 'added', passingRun: null }, update: true });
    // Updated since: its replay passed.
    expect(divergedActions({ ...all, test: added({ normalized: true, passingRun: '01M510PASS' }) })).toEqual({ normalizer: { kind: 'added', passingRun: '01M510PASS' }, update: false });
    expect(divergedActions({ ...all, hasUpdateJob: false, test: added({ normalized: true }) }).update).toBe(false);
  });

  it('falls back to the run’s own action without the tests’ job, and shows the job off on a read-only dashboard', () => {
    expect(divergedActions({ ...all, hasNormalizeJob: false, hasUpdateJob: false, test: test() })).toEqual({ normalizer: { kind: 'action' }, update: false });
    // The run's own action adds the rule alone, records nothing: it needs no asking either way.
    expect(divergedActions({ ...all, hasNormalizeJob: false, hasUpdateJob: false, test: added() })).toEqual({ normalizer: { kind: 'action' }, update: false });
    const readOnly = 'This dashboard is read-only: it was started with --read-only.';
    expect(divergedActions({ ...all, actionsOff: readOnly, test: test() }).normalizer).toEqual({ kind: 'job', label: 'Add normalizer and re-run', lead: true, off: readOnly, title: readOnly, asks: null });
    expect(divergedActions({ ...all, hasNormalizeJob: false, actionsOff: readOnly, test: test() }).normalizer).toBeNull();
    // A server that says nothing of the test.
    expect(divergedActions({ ...all, test: null })).toEqual({ normalizer: { kind: 'action' }, update: false });
  });

  it('words Update golden as the Tests screen does for the same golden', () => {
    const CHECKS = ['issue_refund called 1 time', 'send_email called 1 time'];
    const tests = (t: TestBannerOffer): TestsView =>
      ({
        rows: [{ path: t.golden, name: goldenName(t.golden), checks: t.checks ?? [], last: { line: '' } }],
        divergences: [{ golden: t.golden, name: goldenName(t.golden), callNo: 3, volatile: t.volatile, normalizerFixes: t.normalizerFixes, maybeReal: t.maybeReal, normalizeAndTest: t.normalizeAndTest, rulesAdded: t.normalized, found: null, missed: null, bisect: null, unreadable: null }],
        inconclusive: [],
      }) as unknown as TestsView;
    const each = [added({ checks: CHECKS }), test({ golden: 'goldens/refund-in-limit', checks: CHECKS }), added({ normalized: true, checks: CHECKS }), added({ checks: [] }), test({ checks: ['issue_refund called 1 time'], volatile: { ...test().volatile!, certain: false } })];
    for (const t of each) {
      const copy = updateGoldenCopy(t, 3, true);
      const plan = updatePlan(tests(t), [t.golden], () => true);
      expect(copy.title).toBe(plan.title);
      expect(copy.lead).toBe(plan.lead);
      expect(copy.goldens).toEqual(plan.goldens);
      expect(copy.steps).toEqual(plan.steps);
      expect(copy.ok).toBe(plan.ok);
      expect(copy.advise).toEqual(plan.advise);
      expect(copy.instead?.label ?? null).toBe(plan.instead?.label ?? null);
      expect(copy.note).toBe(null);
    }
    // A field the recording never had: the amber box's button adds the rule and updates.
    expect(updateGoldenCopy(added({ checks: CHECKS }), 3, true)).toMatchObject({
      title: 'Update refund-in-limit?',
      goldens: [{ name: 'refund-in-limit', where: '#3 ~ $.metadata.user_id' }],
      advise: { path: '$.metadata.user_id', text: 'is a UUID, new every run. Add normalizer and update masks it first.' },
      instead: { label: 'Add normalizer and update' },
      note: null,
      ok: 'Update anyway',
    });
    expect(updateGoldenCopy(test(), 3, true).instead?.label).toBe('Add normalizer and re-run');
    // Where the server can't add it, the advice says so with no way on.
    expect(updateGoldenCopy(added(), 3, false).instead).toBeNull();
    // A golden with no checks is judged on its exit status; a server that doesn't send them, by what the replay ran.
    expect(updateGoldenCopy(added({ checks: [] }), 3, true).steps[1][0]).toBe('Replaced only if it exits 0');
    expect(updateGoldenCopy(added(), 3, true, 1).steps[1][0]).toBe('Replaced only if its check passes');
    expect(updateGoldenCopy(added(), 3, true).steps[1][0]).toBe('Replaced only if its checks pass');
  });
});

describe('Push on a run page', () => {
  it('says what it sends: the run, its attempts only here, or both', () => {
    expect(pushTitle({ store: 'bucket/team', state: 'only-here' })).toBe('Copy this run to the team store, bucket/team, with the runs it came from');
    expect(pushTitle({ store: 'bucket/team', state: 'only-here', localAttempts: { run: true, attempts: 3 } })).toBe('Copy this run and its 3 attempts to the team store, bucket/team, with the runs it came from');
    expect(pushTitle({ store: 'bucket/team', state: 'only-here', localAttempts: { run: false, attempts: 1 } })).toBe('Copy this run’s attempt to the team store, bucket/team: the run is there already');
    expect(canPush({ exported: false, live: false, hasPush: true, team: { store: 'bucket/team', state: 'only-here', localAttempts: { run: false, attempts: 2 } } })).toBe(true);
  });
});
