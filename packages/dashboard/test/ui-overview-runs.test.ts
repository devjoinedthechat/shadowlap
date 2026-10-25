import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOtlpFile, readOtel } from '../../cli/src/import-otel.js';
import { runsLinkQuery, runsQueryString } from '../ui/runspage/query.js';
import { activityGlyph, activityLine, blameWords, chartScale, dayText, dotLine, kindGlyph, needsLookAction, needsLookShown, originCounts, originRows, personName, reproducedNote, share, spentNote, testsKpi, tickText, todayBlameCount, todayTestsLine, verifiedNote } from '../ui/overview/model.js';
import { authorTint, ciName } from '../ui/runspage/authors.js';
import { bulkToast, deleteText, deleteWhat, localTitle, PACK_MAX, packCommand, packFolders, packOff, rmCommand } from '../ui/runspage/bulk.js';
import { datasetCommand, datasetFile } from '../ui/run/share.js';
import { packFolders as serverPackFolders } from '../src/run-exports.js';
import { bisectCommand, bisectCost, bisectRequest, revisionTally } from '../ui/runspage/find-commit.js';
import { calSummary, counted, dayTip, dragEnd, dragOver, dragStart, failedOf, keyPick, monthLabels, moveDay, pickedOf, pickedRange, rangeTimes, shownRange, spanText } from '../ui/runspage/calendar-model.js';
import { fileHead, FILE_FORMATS, HEAD_BYTES, IMPORT_FILE_FORMATS, keyList, OTEL_SAMPLE_NAME, pickedFormat, redateTrace, sampleTrace, tooLargeNote } from '../ui/runspage/imports.js';
import { OTEL_SAMPLE, type OtlpTrace } from '../ui/runspage/sample-otel.js';
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
    // Today's blame line, in the words Needs a look uses for the same fix.
    expect(blameWords({ outcome: 'blamed', lostAt: 7 })).toBe('lost at #7');
    expect(blameWords({ outcome: 'unrescuable', lostAt: null })).toBe('not rescued from any model call');
    // One whose first probe couldn't tell is not settled, never a finding that no call rescues the run.
    expect(blameWords({ outcome: 'unrescuable', unsettled: true, lostAt: null })).toBe('not settled from the first model call');
    expect(blameWords({ outcome: 'stopped', lostAt: null })).toBe('blame stopped early');
    expect(blameWords({ outcome: null, lostAt: null })).toBe('not placed yet');
    expect(testsKpi(null, 0)).toEqual({ value: '—', note: 'no goldens yet', tone: '' });
    const now = new Date(2026, 9, 1, 12, 0).getTime();
    const at1002 = new Date(2026, 9, 1, 10, 2).getTime();
    // Each part is kept whole, so a line that wraps breaks after a dot only.
    expect(dotLine(['1 failed', 'last run 10:02'])).toBe('1\u00a0failed\u00a0· last\u00a0run\u00a010:02');
    const words = <T extends { note?: string; text?: string }>(o: T) => ({ ...o, ...(o.note ? { note: o.note.replace(/\u00a0/g, ' ') } : {}), ...(o.text ? { text: o.text.replace(/\u00a0/g, ' ') } : {}) });
    // Every golden is accounted for, in Tests' words: 5 of 7 pass, 1 failed, 1 has not run yet.
    expect(words(testsKpi({ goldens: 7, passing: 5, inconclusive: 0, untested: 1, lastWeek: 4, regressions: 1, lastRunAt: at1002 }, now))).toEqual({ value: '5 / 7', note: '1 failed · 1 not run yet · last run 10:02', tone: 'err' });
    expect(words(testsKpi({ goldens: 2, passing: 2, inconclusive: 0, untested: 0, lastWeek: null, regressions: 0, lastRunAt: at1002 }, now)).note).toBe('all passed · last run 10:02');
    expect(words(testsKpi({ goldens: 2, passing: 0, inconclusive: 0, untested: 2, lastWeek: null, regressions: 0, lastRunAt: null }, now)).note).toBe('2 not run yet');
    // Inconclusive goldens count apart, neither passing nor failed: amber when they are the only problem.
    expect(words(testsKpi({ goldens: 4, passing: 3, inconclusive: 1, untested: 0, lastWeek: null, regressions: 0, lastRunAt: at1002 }, now))).toEqual({ value: '3 / 4', note: '1 inconclusive · last run 10:02', tone: 'warn' });
    // Today's Tests line counts the goldens as the tile does, and the replays that ran today on hover.
    const seven = { goldens: 7, passing: 5, inconclusive: 0, untested: 1, lastWeek: null, regressions: 1, lastRunAt: at1002 };
    expect(words(todayTestsLine(seven, { count: 8, failed: 2, inconclusive: 0 }, 'diverged at #3'))).toEqual({ text: '1 failed · 1 not run yet', icon: 'fail', count: '7 goldens', title: '8 test replays today · 2 failed, the newest diverged at #3' });
    expect(words(todayTestsLine({ ...seven, regressions: 0, inconclusive: 1, untested: 0, passing: 6 }, { count: 3, failed: 0, inconclusive: 1 }, null))).toEqual({ text: '1 inconclusive', icon: 'warn', count: '7 goldens', title: '3 test replays today · 1 inconclusive' });
    expect(todayTestsLine({ ...seven, regressions: 0, untested: 0, passing: 7 }, { count: 0, failed: 0 }, null)).toEqual({ text: 'all passed', icon: 'test', count: '7 goldens', title: 'No test replays today' });
    expect(todayTestsLine(null, { count: 0, failed: 0 }, null)).toMatchObject({ text: 'no goldens yet', count: '0 goldens' });
    // Blame counts blames, as Replays and Forks count runs, with the model calls they probed and their attempts on hover.
    expect(todayBlameCount({ blames: 3, probes: 12, attempts: 48 })).toEqual({ count: '3 today', title: '12 probes · 48 attempts' });
    // Where nothing runs, every line of Needs a look opens what it names.
    expect(needsLookAction({ action: 'Run blame' }, null)).toBe('Run blame');
    expect(needsLookAction({ action: 'Run blame' }, 'This dashboard is read-only: it was started with --read-only.')).toBe('Open');
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
    expect(activityGlyph('warn')).toBe('warn');
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

  it('offers a sample trace that the CLI imports as one run, dated to end now', () => {
    // The trace the CLI's own import tests read, which the demo store imports as captures/otel-traces.json.
    const fixture = JSON.parse(readFileSync(new URL('../../cli/test/fixtures/traces/otel-genai.json', import.meta.url), 'utf8')) as unknown;
    expect(OTEL_SAMPLE).toEqual(fixture);
    const now = Date.UTC(2026, 9, 17, 14, 5, 0);
    const sample = sampleTrace(now);
    expect(sample.name).toBe(OTEL_SAMPLE_NAME);
    expect(sample.name).toBe('otel-traces.json');
    // Picked as a file would be: OpenTelemetry, from its name and its first bytes.
    expect(pickedFormat(sample.name, sample.text.length, sample.text.slice(0, HEAD_BYTES), 64 * 1024 * 1024)).toEqual({ format: 'otel', error: null });
    const [trace, ...more] = readOtel(parseOtlpFile(sample.text)).traces;
    expect(more).toEqual([]);
    expect(trace.calls.map((c) => (c.kind === 'model' ? `model ${c.model}` : `tool ${c.name}`))).toEqual(['model claude-haiku-4-5', 'tool lookup_order', 'model claude-haiku-4-5']);
    // Its own pacing kept: the agent span's 2.6 s end at the moment given.
    const spans = (JSON.parse(sample.text) as OtlpTrace).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((sc) => sc.spans));
    const ms = (v: string | undefined) => Number(BigInt(v!) / 1_000_000n);
    expect(Math.max(...spans.map((sp) => ms(sp.endTimeUnixNano)))).toBe(now);
    expect(Math.min(...spans.map((sp) => ms(sp.startTimeUnixNano)))).toBe(now - 2600);
    // The shipped sample itself is left as it is.
    expect(OTEL_SAMPLE).toEqual(fixture);
  });

  it('moves a trace in time by whole nanoseconds, and leaves what isn’t a time alone', () => {
    const trace: OtlpTrace = { resourceSpans: [{ scopeSpans: [{ spans: [{ startTimeUnixNano: '1000000000', endTimeUnixNano: '3000000000', events: [{ timeUnixNano: '2500000000', name: 'x' }, { name: 'no time' }] }, { startTimeUnixNano: 'soon' }] }] }] };
    const moved = redateTrace(trace, 10_000);
    expect(moved.resourceSpans[0].scopeSpans[0].spans).toEqual([
      { startTimeUnixNano: '8000000000', endTimeUnixNano: '10000000000', events: [{ timeUnixNano: '9500000000', name: 'x' }, { name: 'no time' }] },
      { startTimeUnixNano: 'soon' },
    ]);
    const timeless: OtlpTrace = { resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'a' }] }] }] };
    expect(redateTrace(timeless, 10_000)).toBe(timeless);
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
    // The attempts that went with the runs are counted too.
    expect(bulkToast({ verb: 'Deleted', done: ['01K5CQ4N7G0000', '01K5CQ4N9A0000'], of: 2, skipped: [], attempts: 6 })).toBe('Deleted 2 runs and 6 attempts');
    expect(bulkToast({ verb: 'Deleted', done: ['01K5CQ4N7G0000'], of: 1, skipped: [], attempts: 1 })).toBe('Deleted 01K5CQ4N7G and 1 attempt');
  });

  it('names the attempts a bulk Delete takes with the runs, as shadowlap rm deletes them', () => {
    const two = ['01K5CQ4N7G0000000000000000', '01K5CQ4N9A0000000000000000'];
    // A count keeps to its noun where the title wraps.
    expect(deleteWhat(two, 6)).toBe('2\u00a0runs and the 6\u00a0attempts bundled under them');
    expect(deleteWhat(two.slice(0, 1), 1)).toBe('01K5CQ4N7G and the attempt bundled under it');
    expect(deleteWhat(two, 0)).toBe('2\u00a0runs');
    expect(deleteText(2, 6, [])).toBe('Removes the runs, the attempts bundled under them and the recorded data nothing else uses. Their forks keep their own data but lose the link.');
    expect(deleteText(1, 0, ['01K5CQ6L0P0000000000000000'])).toBe('Removes the run and the recorded data nothing else uses. Its forks keep their own data but lose the link. 01K5CQ6L0P is still recording and is left alone.');
    // The command it shows deletes the same: rm takes a run's attempts with it.
    expect(rmCommand(two)).toEqual({ shown: 'shadowlap rm 01K5CQ4N7G 01K5CQ4N9A', full: 'shadowlap rm 01K5CQ4N7G 01K5CQ4N9A' });
    // The run page's Delete says the same of its one run: a recording blame probed six times.
    expect(deleteWhat(two.slice(0, 1), 6)).toBe('01K5CQ4N7G and the 6\u00a0attempts bundled under it');
    expect(deleteText(1, 6, [])).toBe('Removes the run, the attempts bundled under it and the recorded data nothing else uses. Its forks keep their own data but lose the link.');
    expect(bulkToast({ verb: 'Deleted', done: two.slice(0, 1), of: 1, skipped: [], attempts: 6 })).toBe('Deleted 01K5CQ4N7G and 6 attempts');
  });

  it('packs every run picked into a folder of its own, where its dialog says, as one job does', () => {
    const ids = ['01K5CQ4N7G0000000000000000', '01K5CQ4N9A0000000000000000', '01K5CQ4N9A0000000000000001'];
    // The dialog names each folder as the job does (src/run-exports.ts), a run that shares its first ten characters by its whole id.
    expect(packFolders(ids, '.shadowlap/exports/')).toEqual(serverPackFolders(ids, '.shadowlap/exports/'));
    expect(packFolders(ids, '.shadowlap/exports').map((f) => f.folder)).toEqual(['.shadowlap/exports/01k5cq4n7g', '.shadowlap/exports/01k5cq4n9a0000000000000000', '.shadowlap/exports/01k5cq4n9a0000000000000001']);
    expect(packCommand(ids.slice(0, 1), 'goldens')).toEqual({ shown: 'shadowlap pack 01K5CQ4N7G goldens/01k5cq4n7g', full: 'shadowlap pack 01K5CQ4N7G goldens/01k5cq4n7g' });
    expect(packCommand(ids.slice(0, 2), 'my packs')).toEqual({
      shown: "shadowlap pack 01K5CQ4N7G 'my packs/01k5cq4n7g' … and\u00a01\u00a0more, one per run",
      full: "shadowlap pack 01K5CQ4N7G 'my packs/01k5cq4n7g' && shadowlap pack 01K5CQ4N9A 'my packs/01k5cq4n9a'",
    });
    expect(packOff(PACK_MAX)).toBeNull();
    expect(packOff(PACK_MAX + 1)).toBe(`At most ${PACK_MAX} runs are packed at once: ${PACK_MAX + 1} are picked`);
  });

  it('shows the command a dataset runs, with the file it writes', () => {
    const now = new Date('2026-10-22T07:48:12Z');
    expect(datasetFile(['01K5CQ4N7G0000000000000000'], now)).toBe('dataset-01k5cq4n7g.jsonl');
    // Named as the job names it when not told, so a dataset of the same runs is never overwritten.
    expect(datasetFile(['01K5CQ4N7G0000000000000000', '01K5CQ4N9A0000000000000000'], now)).toBe('dataset-2-runs-20261022-074812.jsonl');
    expect(datasetCommand(['01K5CQ4N7G0000000000000000'], { format: 'braintrust', calls: 'model', file: 'dataset-01k5cq4n7g.jsonl' })).toEqual({
      shown: 'shadowlap export dataset 01K5CQ4N7G --calls model --format braintrust --out .shadowlap/exports/dataset-01k5cq4n7g.jsonl',
      full: 'shadowlap export dataset 01K5CQ4N7G --calls model --format braintrust --out .shadowlap/exports/dataset-01k5cq4n7g.jsonl',
    });
    const many = Array.from({ length: 12 }, (_, i) => `01K5CQ4N${String(i).padStart(2, '0')}0000000000000000`);
    const long = datasetCommand(many, { format: 'jsonl', calls: 'final', file: 'x.jsonl' });
    expect(long.shown).toBe('shadowlap export dataset 01K5CQ4N00 01K5CQ4N01 01K5CQ4N02 01K5CQ4N03 01K5CQ4N04 … and 7 more --calls final --format jsonl --out .shadowlap/exports/x.jsonl');
    expect(long.full.split(' ').filter((w) => w.startsWith('01K5CQ4N'))).toHaveLength(12);
  });

  it('says what the search costs: with --fork, one live replay decides each commit', () => {
    expect(bisectCost({ fork: true, live: true })).toBe('One live replay decides each commit, from where its requests differ: it costs tokens, and a failure that doesn’t happen every time can pass at a commit that has it.');
    expect(bisectCost({ fork: false, live: true })).toBe('Its replays run live from where they diverge, so this costs tokens.');
    expect(bisectCost({ fork: false, live: false })).toBe('Replays are free, so this costs no tokens.');
  });

  it('names where Find the commit ends: the failure’s own commit, or HEAD when this checkout lacks it', () => {
    const run = '01K5CQ4N7G0000000000000000';
    const own = { bad: 'ab2a568', target: { kind: 'run' as const, runId: run }, fork: true };
    expect(bisectRequest(run, own, ' 0007d11 ')).toEqual({ runId: run, good: '0007d11', bad: 'ab2a568' });
    expect(bisectCommand(run, own, '0007d11')).toBe('shadowlap bisect 01K5CQ4N7G --good 0007d11 --bad ab2a568 --fork');
    // A teammate's failure: its commit isn't here, so the job is told HEAD rather than left to take
    // the run's own commit.
    const theirs = { ...own, bad: null };
    expect(bisectRequest(run, theirs, '2ef20ae')).toEqual({ runId: run, good: '2ef20ae', bad: 'HEAD' });
    expect(bisectCommand(run, { ...theirs, target: { kind: 'golden', golden: 'goldens/refund-flow' }, fork: false }, '')).toBe('shadowlap bisect goldens/refund-flow --good <commit> --bad HEAD');
    // A run blame found failing a check: the job judges each replay by it, and so does the command shown.
    const check = { tools: { issue_refund: { count: 0, args: { amount: 240 } } } };
    expect(bisectCommand(run, { ...own, expect: check }, '0007d11')).toBe(`shadowlap bisect 01K5CQ4N7G --good 0007d11 --bad ab2a568 --expect '${JSON.stringify(check)}' --fork`);
    // How the runs at each commit went: a golden's inconclusive results are counted apart, never as failures.
    expect([{ runs: 3, failed: 0 }, { runs: 3, failed: 1 }, { runs: 3, failed: 0, inconclusive: 1 }, { runs: 3, failed: 1, inconclusive: 1 }].map(revisionTally)).toEqual(['3 passed', '1 of 3 failed', '1 of 3 inconclusive', '1 of 3 failed, 1 inconclusive']);
  });

  it('says on the local tag what is only on this machine: the run, or attempts Push sends with it', () => {
    expect(localTitle(undefined)).toBe('Only on the machine that recorded it');
    expect(localTitle({ run: true, attempts: 2 })).toBe('Only on the machine that recorded it, with 2 attempts bundled under it');
    expect(localTitle({ run: false, attempts: 1 })).toBe('1 attempt bundled under it is only on this machine: pushing the run sends it');
    expect(localTitle({ run: false, attempts: 3 })).toBe('3 attempts bundled under it are only on this machine: pushing the run sends them');
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
    expect(runsLinkQuery('#/runs?q=imported%20gateway%20%282%29.jsonl')).toEqual({ q: 'imported gateway (2).jsonl', types: 'all', sort: 'when', days: null });
    expect(runsLinkQuery('#/runs?type=failed')).toMatchObject({ q: '', types: 'failed' });
    expect(runsLinkQuery('#/runs?q=refund&type=fork')).toMatchObject({ q: 'refund', types: 'fork' });
    expect(runsLinkQuery('#/runs?type=local')).toMatchObject({ q: '', types: 'local' });
    for (const hash of ['#/runs', '#/runs?type=nightly', '#/runs?q=%20', '#/run/01K5CQ4N7G?q=x', '#token=abc&open=/runs']) expect(runsLinkQuery(hash), hash).toBeNull();
  });

  it('says a run cut short is interrupted, and a run with nothing to report a dash', () => {
    const base: RunLike = { runId: '01K5CQ4N7G0000000000000000', parentRunId: null, mode: 'record', status: 'crashed', divergence: null, command: 'python refund_agent.py', codeVersion: null, startedAt: 0, calls: 3, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], outcome: { kind: 'none' } };
    expect(runOutcome(base)).toEqual({ tone: 'n', text: 'interrupted' });
    expect(runOutcome({ ...base, status: 'completed' })).toEqual({ tone: 'n', text: '—' });
    expect(runOutcome({ ...base, status: 'running', outcome: { kind: 'running' } })).toEqual({ tone: 'live', text: 'in progress' });
    // A check no one could decide, such as a judge with no verdict: amber, needing a look, no failure.
    expect(runOutcome({ ...base, status: 'completed', outcome: { kind: 'inconclusive', check: 'polite' } })).toEqual({ tone: 'warn', text: 'check inconclusive' });
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
