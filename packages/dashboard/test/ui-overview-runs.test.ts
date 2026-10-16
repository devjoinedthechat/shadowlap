import { describe, expect, it } from 'vitest';
import { runsLinkQuery, runsQueryString } from '../ui/runspage/query.js';
import { activityGlyph, activityLine, chartScale, dayText, kindGlyph, needsLookShown, originCounts, originRows, personName, reproducedNote, share, spentNote, testsKpi, tickText, verifiedNote } from '../ui/overview/model.js';
import { authorTint, ciName } from '../ui/runspage/authors.js';
import { bulkToast } from '../ui/runspage/bulk.js';
import { calSummary, counted, dayTip, dragEnd, dragOver, dragStart, failedOf, keyPick, monthLabels, moveDay, pickedOf, pickedRange, rangeTimes, shownRange, spanText } from '../ui/runspage/calendar-model.js';
import { fileHead, FILE_FORMATS, HEAD_BYTES, IMPORT_FILE_FORMATS, keyList, pickedFormat, tooLargeNote } from '../ui/runspage/imports.js';
import { runOutcome, runSpent, type RunLike } from '../ui/runs.js';
import type { DayCount, NeedsLookRow } from '../ui/types.js';

// The Overview's and the Runs page's logic: what each panel says from the server's numbers, how the
// calendar picks days, and how an import guesses a file's format.

const day = (key: string, i: number, over: Partial<DayCount> = {}): DayCount => ({ day: key, start: i * 1000, end: (i + 1) * 1000, weekday: i % 7, runs: 0, failed: 0, all: 0, level: 0, byKind: {}, byAuthor: {}, ...over });

/** Twelve weeks from Monday Jul 27 2026 to Thursday Oct 15 2026: 81 days. */
const DAYS: DayCount[] = Array.from({ length: 81 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 6, 27 + i));
  return day(d.toISOString().slice(0, 10), i);
});

describe('the Overview’s words', () => {
  it('says each outcome as the design does, with a dash and no goldens yet', () => {
    expect(reproducedNote({ value: 2, lastWeek: 1, open: 1 })).toBe('replayed exactly · 1 still open');
    expect(reproducedNote({ value: 0, lastWeek: 0, open: 0 })).toBe('replayed exactly · none open');
    expect(verifiedNote({ value: 1, lastWeek: 0, rejected: 1 })).toBe('1 rejected before it shipped');
    expect(verifiedNote({ value: 1, lastWeek: 0, rejected: 3 })).toBe('3 rejected before they shipped');
    expect(verifiedNote({ value: 1, lastWeek: 0, rejected: 0 })).toBe('none rejected');
    expect(testsKpi(null, 0)).toEqual({ value: '—', note: 'no goldens yet', failing: false });
    const now = new Date(2026, 9, 1, 12, 0).getTime();
    expect(testsKpi({ goldens: 4, passing: 3, lastWeek: 4, regressions: 1, lastRunAt: new Date(2026, 9, 1, 10, 2).getTime() }, now)).toEqual({ value: '3 / 4', note: '1 regression caught · last run 10:02', failing: true });
    expect(testsKpi({ goldens: 2, passing: 2, lastWeek: null, regressions: 0, lastRunAt: null }, now).note).toBe('no regressions · not run yet');
    expect(spentNote({ value: 1.29, lastWeek: 1.69, notRespent: 2.81, notWaitedMs: 28 * 60_000 })).toBe('$2.81 not re-spent · 28m not waited');
  });

  it('lists the origins present in the design’s order, with their shares', () => {
    const counts = originCounts({ r: 1018, l: 1634, o: 3, i: 3, f: 1, b: 25, s: 3 });
    expect(originRows(counts).map((r) => [r.origin, r.count, r.share])).toEqual([
      ['rep', 1018, '38%'],
      ['live', 1634, '61%'],
      ['block', 25, '<1%'],
      ['stub', 3, '<1%'],
      ['over', 3, '<1%'],
      ['inject', 3, '<1%'],
      ['fail', 1, '<1%'],
    ]);
    expect(originRows(originCounts({ r: 0, l: 4 })).map((r) => r.origin)).toEqual(['live']);
    expect(share(0, 0)).toBe('0%');
  });

  it('scales the daily chart to a round top over its largest bar', () => {
    expect(chartScale([0.31, 0.72, 0.12])).toEqual({ max: 0.8, ticks: [0, 0.2, 0.4, 0.6, 0.8] });
    expect(chartScale([0.54, 0.21]).max).toBeGreaterThanOrEqual(0.54);
    expect(chartScale([0, 0]).max).toBeGreaterThan(0);
    expect(chartScale([12.4]).max).toBe(20);
    expect(tickText(0.2)).toBe('$0.20');
    expect(tickText(20)).toBe('$20');
  });

  it('names days, run kinds, activity icons and people the way the panels show them', () => {
    expect(dayText('2026-10-01')).toBe('Oct 1');
    expect(dayText('2026-09-29', true)).toBe('Tue, Sep 29');
    expect(kindGlyph('fork')).toEqual({ kind: 'fork', label: 'Fork' });
    expect(kindGlyph('test', { failed: true }).kind).toBe('fail');
    expect(kindGlyph('recording', { live: true }).kind).toBe('live');
    expect(kindGlyph('pack').kind).toBe('rec');
    expect(activityGlyph('fixok')).toBe('fixok');
    expect(activityGlyph('release')).toBe('rec');
    expect(personName('dana@northwind.example')).toBe('dana');
    expect(personName('ci')).toBe('ci');
    expect(personName(null)).toBe('unknown');
  });

  it('shows three lines of Needs a look, then the rest on asking', () => {
    const row = (i: number): NeedsLookRow => ({ kind: 'unblamed', icon: 'fail', title: `t${i}`, detail: '', action: 'Run blame', href: '#/', runId: String(i), fixId: null, at: i });
    const items = [1, 2, 3, 4, 5].map(row);
    expect(needsLookShown(items, false)).toEqual({ rows: items.slice(0, 3), more: 'Show 2 more' });
    expect(needsLookShown(items, true)).toEqual({ rows: items, more: 'Show fewer' });
    expect(needsLookShown(items.slice(0, 3), false)).toEqual({ rows: items.slice(0, 3), more: null });
    // A line that stands for the rest of its kind is one line to show: the button counts lines it opens.
    expect(needsLookShown([...items, { ...row(6), title: '40 more failed runs not blamed yet', more: 40 }], false).more).toBe('Show 3 more');
  });

  it('says an activity entry’s id once, shortened as the CLI prints it', () => {
    const fix = 'fx-01M50ZZESZ9YQB6RBZ4HWREQ8J';
    // A verdict on a fix with no title: its words ended on the id, which the code says shorter.
    expect(activityLine(`Verify accepted · ${fix}`, fix)).toEqual({ text: 'Verify accepted', code: 'fx-01M50ZZESZ' });
    expect(activityLine('Verify accepted · Escalate refunds above the limit', fix)).toEqual({ text: 'Verify accepted · Escalate refunds above the limit', code: 'fx-01M50ZZESZ' });
    expect(activityLine('Replay clean · 30/30', '01K5CQ4N9A0000000000000000')).toEqual({ text: 'Replay clean · 30/30', code: '01K5CQ4N9A' });
    // Words that name it already need no code; a file or a rule shows as it is.
    expect(activityLine('Golden packed · goldens/refund-flow', 'goldens/refund-flow')).toEqual({ text: 'Golden packed', code: 'goldens/refund-flow' });
    expect(activityLine('Applied fx-01M50ZZESZ to the tree', fix)).toEqual({ text: 'Applied fx-01M50ZZESZ to the tree', code: null });
    expect(activityLine('Tests ran · 2 passed, 0 failed', null)).toEqual({ text: 'Tests ran · 2 passed, 0 failed', code: null });
  });
});

describe('the Runs calendar', () => {
  it('keeps days picked by their keys, so new data keeps the range, and gives the table its instants', () => {
    const range = pickedRange(DAYS, { from: '2026-10-06', to: '2026-10-01' });
    expect(range).toEqual([66, 71]);
    expect(pickedOf(DAYS, [71, 66])).toEqual({ from: '2026-10-01', to: '2026-10-06' });
    expect(rangeTimes(DAYS, range)).toEqual({ from: 66_000, to: 72_000 });
    expect(pickedRange(DAYS, { from: '2025-01-01', to: '2026-10-01' })).toBeNull();
    expect(pickedRange(DAYS, null)).toBeNull();
  });

  it('picks a day with a click, several with a drag or Shift-click, and clears on clicking the day again', () => {
    expect(dragEnd(dragStart(10, null, false))).toEqual([10, 10]);
    expect(dragEnd(dragOver(dragOver(dragStart(10, null, false), 12), 4))).toEqual([4, 10]);
    expect(dragEnd(dragStart(10, [10, 10], false))).toBeNull();
    // A drag that starts on the day picked and moves keeps a range.
    expect(dragEnd(dragOver(dragStart(10, [10, 10], false), 11))).toEqual([10, 11]);
    // Shift extends from the far end of what is picked.
    expect(dragEnd(dragStart(20, [5, 8], true))).toEqual([5, 20]);
    expect(dragEnd(dragStart(2, [5, 8], true))).toEqual([2, 8]);
    expect(shownRange({ a: 9, b: 3, moved: true, again: false }, [1, 1])).toEqual([3, 9]);
    expect(shownRange(null, [1, 2])).toEqual([1, 2]);
  });

  it('moves between days with the arrow keys, a column a week, and picks with Enter', () => {
    expect(moveDay(10, 'ArrowLeft', 81)).toBe(3);
    expect(moveDay(10, 'ArrowRight', 81)).toBe(17);
    expect(moveDay(10, 'ArrowUp', 81)).toBe(9);
    expect(moveDay(80, 'ArrowDown', 81)).toBeNull();
    expect(moveDay(10, 'Tab', 81)).toBeNull();
    expect(keyPick(10, null, false)).toEqual([10, 10]);
    expect(keyPick(10, [10, 10], false)).toBeNull();
    expect(keyPick(14, [10, 12], true)).toEqual([10, 14]);
  });

  it('names the months over their first week, and the first week’s unless the next name crowds it', () => {
    expect(monthLabels(DAYS)).toEqual([
      { col: 1, label: 'Aug' },
      { col: 6, label: 'Sep' },
      { col: 10, label: 'Oct' },
    ]);
    const fromJul6 = Array.from({ length: 84 }, (_, i) => day(new Date(Date.UTC(2026, 6, 6 + i)).toISOString().slice(0, 10), i));
    expect(monthLabels(fromJul6).map((m) => m.label)).toEqual(['Jul', 'Aug', 'Sep']);
  });

  it('sums the days picked, or all twelve weeks, with the busiest day and who ran most', () => {
    const days = DAYS.map((d, i) => (i === 70 ? { ...d, runs: 14, failed: 3, all: 14, byAuthor: { 'dana@x': 10, ci: 4 } } : i === 71 ? { ...d, runs: 4, failed: 1, all: 6, byAuthor: { ci: 4 } } : d));
    const all = calSummary(days, null);
    expect(all).toMatchObject({ runs: 18, failed: 4, all: 20, busiest: { index: 70, runs: 14 } });
    expect(all.people).toEqual([
      { author: 'ci', runs: 8 },
      { author: 'dana@x', runs: 10 },
    ].sort((a, b) => b.runs - a.runs));
    expect(calSummary(days, [71, 71])).toMatchObject({ runs: 4, failed: 1, all: 6, busiest: { index: 71, runs: 4 } });
    expect(calSummary(days, [0, 5]).busiest).toBeNull();
    expect(failedOf(33, 189, 'runs')).toBe('of 189 runs · 17%');
    expect(failedOf(0, 4, 'forks')).toBe('of 4 forks');
    expect(failedOf(1, 400, 'runs')).toBe('of 400 runs · <1%');
    expect(counted(1, 'failed runs')).toBe('1 failed run');
    expect(spanText(DAYS, [80, 80])).toBe('on Thu, Oct 15');
    expect(spanText(DAYS, [71, 78])).toBe('from Oct 6 to Oct 13');
  });

  it('says a day’s runs by kind on hover, or by person with a team store, and adds its failures', () => {
    const d = day('2026-09-29', 64, { runs: 3, failed: 1, all: 3, byKind: { recording: 1, pack: 1, fork: 1 }, byAuthor: { 'maya@x': 2, ci: 1 } });
    expect(dayTip(d, { today: false, noun: 'runs', byPerson: false, failedChip: false })).toEqual({
      title: 'Tue, Sep 29 · 3 runs',
      rows: [
        { label: 'recordings', value: '2', color: 'var(--line2)' },
        { label: 'forks', value: '1', color: 'var(--line2)' },
        { label: 'failed', value: '1', color: 'var(--err)' },
      ],
    });
    expect(dayTip(d, { today: true, noun: 'failed runs', byPerson: true, failedChip: true })).toEqual({
      title: 'Tue, Sep 29 (today) · 3 failed runs',
      rows: [
        { label: 'maya', value: '2', color: 'var(--lime)' },
        { label: 'ci', value: '1', color: 'var(--faint)' },
      ],
    });
    expect(dayTip(day('2026-09-30', 65), { today: false, noun: 'forks', byPerson: false, failedChip: false }).title).toBe('Wed, Sep 30 · no forks');
  });
});

describe('importing a file', () => {
  it('guesses the format as the engine does, from the name and then the first bytes, and refuses YAML and anything else with the reason', () => {
    const guess = (name: string, head?: string) => pickedFormat(name, 100, head === undefined ? undefined : new TextEncoder().encode(head), 64 * 1024 * 1024);
    expect(guess('traffic.har')).toEqual({ format: 'har', error: null });
    expect(guess('cap/2026-09-30.jsonl')).toEqual({ format: 'litellm', error: null });
    expect(guess('otel-traces.json').format).toBe('otel');
    expect(guess('OTLP_export.JSON').format).toBe('otel');
    expect(guess('refund_cassette.json').format).toBe('vcr');
    expect(guess('recording.json').format).toBe('nock');
    // What the name doesn't say, the content does: a HAR saved as .json, OTLP lines in a .jsonl.
    const har = JSON.stringify({ log: { version: '1.2', creator: { name: 'Chrome' }, entries: [] } });
    const otlp = JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [] }] });
    expect(guess('capture.json', har)).toEqual({ format: 'har', error: null });
    expect(guess('collector-spans.jsonl', `${otlp}\n${otlp}\n`)).toEqual({ format: 'otel', error: null });
    expect(guess('capture.json', JSON.stringify([{ scope: 'https://api.anthropic.com:443', method: 'POST', path: '/v1/messages' }]))).toEqual({ format: 'nock', error: null });
    expect(guess('worker-1.jsonl', '{"format":"shadowlap-capture","v":1}\n')).toEqual({ format: 'litellm', error: null });
    expect(guess('cassette.yaml')).toEqual({ format: null, error: expect.stringMatching(/^A YAML cassette has to be converted to JSON first/) });
    expect(guess('cassette.yml', 'interactions:\n').format).toBeNull();
    expect(guess('notes.txt')).toEqual({ format: null, error: expect.stringMatching(/^Not a format Shadowlap imports/) });
    expect(guess('Makefile').format).toBeNull();
    // The select names every format the CLI imports, as the engine names them.
    expect(FILE_FORMATS.map((f) => IMPORT_FILE_FORMATS[f])).toEqual(['HAR', 'nock', 'VCR (JSON)', 'LiteLLM', 'OpenTelemetry']);
  });

  it('reads only the start of a file to guess it, and a file too large to send says so', async () => {
    const big = new Blob([JSON.stringify({ log: { entries: [] } }), ' '.repeat(3 * HEAD_BYTES)]);
    const head = await fileHead(big);
    expect(head?.length).toBe(HEAD_BYTES);
    expect(pickedFormat('download.json', big.size, head, null)).toEqual({ format: 'har', error: null });
    expect(pickedFormat('download.json', 100 * 1024 * 1024, head, 64 * 1024 * 1024)).toEqual({ format: 'har', error: 'This file is 100 MB, more than the dashboard takes (64 MB): import it in a terminal with shadowlap import har <file>.' });
    // A file the browser can't read is guessed from its name alone.
    const unreadable = { slice: () => ({ arrayBuffer: () => Promise.reject(new Error('gone')) }) } as unknown as Blob;
    expect(await fileHead(unreadable)).toBeUndefined();
  });

  it('says what to do with a file larger than the dashboard takes, and names the keys a trace needs', () => {
    const MB = 1024 * 1024;
    expect(tooLargeNote(10 * MB, 64 * MB, 'har')).toBeNull();
    expect(tooLargeNote(100 * MB, 64 * MB, 'har')).toBe('This file is 100 MB, more than the dashboard takes (64 MB): import it in a terminal with shadowlap import har <file>.');
    expect(tooLargeNote(100 * MB, null, 'har')).toBeNull();
    expect(keyList(['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'])).toBe('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
    expect(keyList(['LANGSMITH_API_KEY'])).toBe('LANGSMITH_API_KEY');
  });
});

describe('the Runs page’s requests and words', () => {
  it('asks the server for only what is set', () => {
    expect(runsQueryString({})).toBe('');
    expect(runsQueryString({ limit: 50, types: ['failed'], q: '  refund ', sort: 'when', from: 0, to: 5 })).toBe('?limit=50&from=0&to=5&types=failed&q=refund');
    expect(runsQueryString({ sort: 'spent', cursor: 'abc', tz: 'Europe/Berlin', weeks: 12 })).toBe('?cursor=abc&sort=spent&tz=Europe%2FBerlin&weeks=12');
  });

  it('says what a bulk action did, and which runs it left alone', () => {
    expect(bulkToast({ verb: 'Deleted', done: ['01K5CQ4N7G0000', '01K5CQ4N9A0000'], of: 2, skipped: [] })).toBe('Deleted 2 runs');
    expect(bulkToast({ verb: 'Labelled', done: ['01K5CQ4N7G0000'], of: 1, skipped: [], suffix: ' “good”' })).toBe('Labelled 01K5CQ4N7G “good”');
    expect(bulkToast({ verb: 'Deleted', done: ['01K5CQ4N7G0000'], of: 2, skipped: [{ runId: '01K5CQ6L0P0000', reason: 'still recording' }] })).toBe('Deleted 1 of 2 runs · 01K5CQ6L0P is still recording');
  });

  it('gives each person one tint, and CI its own author named by its provider', () => {
    expect(authorTint('dana@northwind.example')).toBe(authorTint('dana@northwind.example'));
    expect(authorTint('ci')).toBe('bot');
    expect(authorTint(null)).toBe('bot');
    expect(['t1', 't2', 't3', 't4']).toContain(authorTint('maya@northwind.example'));
    expect(ciName('github')).toBe('GitHub Actions');
    expect(ciName('drone')).toBe('drone');
    expect(ciName(null)).toBeNull();
  });

  it('takes the filter a link to Runs asks for, and nothing else', () => {
    expect(runsLinkQuery('#/runs?q=imported%20gateway%20%282%29.jsonl')).toEqual({ q: 'imported gateway (2).jsonl', chip: 'all' });
    expect(runsLinkQuery('#/runs?type=failed')).toEqual({ q: '', chip: 'failed' });
    expect(runsLinkQuery('#/runs?q=refund&type=fork')).toEqual({ q: 'refund', chip: 'fork' });
    for (const hash of ['#/runs', '#/runs?type=nightly', '#/runs?q=%20', '#/run/01K5CQ4N7G?q=x', '#token=abc&open=/runs']) expect(runsLinkQuery(hash), hash).toBeNull();
  });

  it('says a run cut short is interrupted, and a run with nothing to report a dash', () => {
    const base: RunLike = { runId: '01K5CQ4N7G0000000000000000', parentRunId: null, mode: 'record', status: 'crashed', divergence: null, command: 'python refund_agent.py', codeVersion: null, startedAt: 0, calls: 3, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], outcome: { kind: 'none' } };
    expect(runOutcome(base)).toEqual({ tone: 'n', text: 'interrupted' });
    expect(runOutcome({ ...base, status: 'completed' })).toEqual({ tone: 'n', text: '—' });
    expect(runOutcome({ ...base, status: 'running', outcome: { kind: 'running' } })).toEqual({ tone: 'live', text: 'in progress' });
  });

  it('shows what a run spent, a capture as captured and a run recorded elsewhere by what it cost there', () => {
    const base: RunLike = { runId: '01K5CQ4N7G0000000000000000', parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'python refund_agent.py', codeVersion: null, startedAt: 0, calls: 30, spent: 0.051, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [] };
    expect(runSpent(base)).toEqual({ text: '≈$0.051', captured: false });
    // A teammate's run, pulled from the team store: it spent live on their machine.
    expect(runSpent({ ...base, imported: true, spent: 0, captured: 0.072 })).toEqual({ text: '≈$0.072', captured: false });
    // Traffic another tool captured has no command of its own.
    expect(runSpent({ ...base, command: '', source: 'traffic.har', covers: ['api'], imported: true, spent: 0, captured: 0.4 })).toEqual({ text: '$0.4', captured: true });
  });
});
