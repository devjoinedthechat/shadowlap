import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FindingPanel, MATRIX_STATES, ResultsMatrixPart } from '../ui/components/FindingPanel.js';
import { ResultsToggle } from '../ui/components/ResultsToggle.js';
import { MatrixKey } from '../ui/components/MatrixKey.js';
import { Receipt } from '../ui/components/Receipt.js';
import { ResultsMatrix } from '../ui/components/ResultsMatrix.js';
import { cellName, cellTone, glueBound, groupRows, keyLines, quietNote, resultsKey, TONE_COLOUR, type Matrix, type MatrixCell, type MatrixCol, type MatrixRow, type ReadRow, type Worst } from '../ui/matrix.js';
import { bandsOf, fitMatrix, keyStart, openGroups, resetMatrixState, shownRows, toggleGroup, type Measure } from '../ui/matrix-fit.js';
import { AppContext } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';
import { app } from './ui-route-helpers.js';

/**
 * The results matrix, one design for an injection test (its untrusted reads by payload) and the
 * error-path presets (a run by preset): each column as wide as its longest unbroken head, its widest
 * tally and bound and the word "inconclusive"; columns that don't fit wrap into balanced bands where
 * it has one row and scroll in one band where it has several; narrower than 560px a matrix of three
 * rows or fewer turns where turned it fits; past eight reads a row for each tool. Its cells in the
 * consequence colours, read by their text; its key's lines; its receipt; the panel a finding opens.
 */

/** A fixed pen: 6px a character in the parts set in the mono face at 11px, 7px in the rest. */
const pen: Measure = (t, part) => t.length * (part === 'head' || part === 'tally' || part === 'bound' || part === 'chip' ? 6 : 7);
const room = (width: number | null, narrow = false) => ({ width, fallback: 1100, narrow });

const RUN = '01K5CQ4N7G';
const PRESET_COLS: MatrixCol[] = [
  ['timeout', 'tool timeout'],
  ['empty', 'empty result'],
  ['malformed', 'malformed JSON'],
  ['oversized', 'oversized result'],
  ['429', 'provider 429'],
  ['500', 'provider 500'],
].map(([key, label]) => ({ key: key, label: label }));

/** A run against the six presets: one row. */
function presets(cell: (col: MatrixCol) => MatrixCell | null = () => ({ word: 'passed', tally: '6 of 6 passed' }), row: Partial<MatrixRow> = {}, cols = PRESET_COLS): Matrix {
  return { id: `presets-${RUN}`, label: `Error-path presets on ${RUN}`, rowInLabel: true, corner: 'run', rows: [{ key: RUN, label: RUN, ...row }], cols, cell: (_r, c) => cell(c) };
}

const TEMPLATES = ['system-notice', 'system-tags', 'developer-note', 'html-comment', 'hidden-text', 'image-alt', 'tool-json', 'function-result', 'user-urgent', 'user-recipient', 'exfil-conversation', 'exfil-secrets'];
const templateCols: MatrixCol[] = TEMPLATES.map((id) => ({ key: id, label: id }));
const readRow = (n: number, tool: string): MatrixRow => ({ key: String(n), label: `#${n} ${tool}`, href: `#/run/${RUN}/${n}`, sub: 'config' });

/** An injection test's untrusted reads by the twelve templates: several rows. */
function injection(rows: MatrixRow[], cell: (row: MatrixRow, col: MatrixCol) => MatrixCell | null = () => ({ word: 'ignored', tally: '3 of 3 inconclusive' })): Matrix {
  return { id: 'inj-01K5CQ', label: 'Untrusted reads by payload', corner: 'untrusted read', rows, cols: templateCols, cell };
}

/** A grid of plain rows and columns, each cell passed once. */
function grid(rows: number, cols: number, tally = '1 of 1 passed'): Matrix {
  const rs = Array.from({ length: rows }, (_, i) => ({ key: `r${i + 1}`, label: `r${i + 1}` }));
  const cs = Array.from({ length: cols }, (_, i) => ({ key: `c${i + 1}`, label: `c${i + 1}` }));
  return { id: 'grid', label: 'Grid', corner: 'row', rows: rs, cols: cs, cell: () => ({ word: 'passed', tally }) };
}

afterEach(() => {
  resetMatrixState();
  vi.unstubAllGlobals();
});

describe('a column’s and the row heads’ widths', () => {
  it('makes a column as wide as the word inconclusive, its widest tally and its widest bound need, its head’s widest piece and 84px at least', () => {
    // "inconclusive" (84) beats the tally "6 of 6 passed" (78) and every head's piece ("malformed", 54 + 12)
    expect(fitMatrix(presets(), room(1100), pen).cw).toBe(84 + 14);
    // a tally wider than the word: "3 of 3 inconclusive", 114
    expect(fitMatrix(presets(() => ({ word: 'inconclusive', tally: '3 of 3 inconclusive' })), room(1100), pen).cw).toBe(114 + 14);
    // a bound kept whole: "rate >= 0.60 (90%)" is one piece, 108
    expect(fitMatrix(presets(() => ({ word: 'passed', bound: 'rate >= 0.60 (90%)' })), room(1100), pen).cw).toBe(108 + 14);
    // a range breaks only before "to": its pieces "rate 0.50" (54) and "to 0.96 (90%)" (78), so the word decides
    expect(fitMatrix(presets(() => ({ word: 'passed', bound: 'rate 0.50 to 0.96 (90%)' })), room(1100), pen).cw).toBe(84 + 14);
    // a head that can't break (an id) is whole, past 180: the grid lets the column grow to 180px, never narrower than it needs
    const long = [{ key: 'x', label: 'exfiltrate_credentials_via_markdown' }];
    expect(fitMatrix(presets(undefined, {}, long), room(1100), pen).cw).toBe(35 * 6 + 12);
    // a head breaks at a space and after a hyphen: "exfil-" and "conversation_and_instructions" are its pieces
    expect(fitMatrix(presets(() => ({ word: 'ok' }), {}, [{ key: 'e', label: 'exfil-conversation_and_instructions' }]), room(1100), pen).cw).toBe(29 * 6 + 12);
    // nothing in the matrix is narrower than 84px
    expect(fitMatrix(presets(() => ({ word: 'ok', tally: '1' }), {}, [{ key: 'a', label: 'a' }]), room(1100), (t) => t.length).cw).toBe(84);
  });

  it('makes the row heads as wide as the longest, 96px at least, 260px and 42% of the room at most', () => {
    expect(fitMatrix(presets(), room(1100), pen).rh).toBe(96);
    expect(fitMatrix(injection([readRow(4, 'get_ticket')]), room(1100), pen).rh).toBe(13 * 7 + 12);
    expect(fitMatrix(injection([readRow(4, 'a_tool_with_a_very_long_name_indeed_here')]), room(1100), pen).rh).toBe(260);
    expect(fitMatrix(injection([readRow(4, 'get_ticket')]), room(200), pen).rh).toBe(84);
    // a run's head as drawn: its id, its golden's chip 8px after it in 16px of padding, room for its about line's shortest form
    expect(fitMatrix(presets(undefined, { chip: 'refund-over-limit' }), room(1100), pen).rh).toBe(70 + 8 + 17 * 6 + 16 + 12);
    expect(fitMatrix(presets(undefined, { subMin: 'refunds a damaged order twice' }), room(1100), pen).rh).toBe(29 * 7 + 12);
  });
});

describe('bands', () => {
  it('balances the columns that don’t fit: six at four a band are two of three, at two three of two, at five two of three', () => {
    expect(bandsOf(6, 4)).toEqual({ n: 3, bands: [{ from: 0, to: 3, fill: 0 }, { from: 3, to: 6, fill: 0 }] });
    expect(bandsOf(6, 2).bands.map((b) => b.to - b.from)).toEqual([2, 2, 2]);
    expect(bandsOf(6, 5).bands.map((b) => b.to - b.from)).toEqual([3, 3]);
    // the last band ends after its last column, empty places keeping its cells under the first band's
    expect(bandsOf(5, 4)).toEqual({ n: 3, bands: [{ from: 0, to: 3, fill: 0 }, { from: 3, to: 5, fill: 1 }] });
    expect(bandsOf(12, 12).bands).toHaveLength(1);
  });

  it('wraps a matrix of one row into bands as the room allows, never scrolling', () => {
    // 98px columns, 96px heads: (1100 - 96) / 102 holds all six
    expect(fitMatrix(presets(), room(1100), pen)).toEqual({ flip: false, per: 6, rh: 96, cw: 98, w: 0 });
    expect(fitMatrix(presets(), room(600), pen)).toEqual({ flip: false, per: 4, rh: 96, cw: 98, w: 0 });
    // not laid out yet: fitted to the room it will have, never turned
    expect(fitMatrix(presets(), { width: null, fallback: 500, narrow: false }, pen)).toEqual({ flip: false, per: 3, rh: 96, cw: 98, w: 0 });
  });

  it('sets a matrix of several rows that don’t fit in one band of every column, which scrolls', () => {
    const two = injection([readRow(4, 'get_ticket'), readRow(9, 'fetch_page')]);
    // "3 of 3 inconclusive" (114) makes the columns 128px, the heads 103px
    expect(fitMatrix(two, room(1100), pen)).toEqual({ flip: false, per: 12, rh: 103, cw: 128, w: 103 + 12 * 132 });
    // a phone's room (390 less two 16px gutters): turned, the twelve payloads wouldn't fit two reads wide
    expect(fitMatrix(two, room(358), pen)).toEqual({ flip: false, per: 12, rh: 103, cw: 128, w: 103 + 12 * 132 });
    expect(fitMatrix(two, { width: null, fallback: 600, narrow: false }, pen).w).toBe(0);
  });

  it('shows an opened group’s members under it, its line for the rest last', () => {
    const rows = groupRows(fortyTwo());
    const m = injection(rows);
    expect(shownRows(m, () => false).map((r) => r.row.key)).toEqual(['g:get_ticket', 'g:fetch_page']);
    const open = shownRows(m, (r) => r.key === 'g:get_ticket');
    expect(open.map((r) => [r.row.key, r.member])).toEqual([
      ['g:get_ticket', false],
      ['12', true],
      ['36', true],
      ['28', true],
      ['q:get_ticket', true],
      ['g:fetch_page', false],
    ]);
  });
});

describe('turning under 560px', () => {
  it('turns a matrix of three rows or fewer whose columns don’t fit, where turned it fits', () => {
    // 98px columns: (500 - 96) / 102 holds three of six
    expect(fitMatrix(grid(3, 6), room(500), pen)).toEqual({ flip: true, per: 3, rh: 96, cw: 98, w: 0 });
    expect(fitMatrix(grid(1, 6), room(358), pen)).toEqual({ flip: true, per: 1, rh: 96, cw: 98, w: 0 });
    // the injection test's two reads in the inspector's 470px: each read a column, its cells as wide as they need
    expect(fitMatrix(injection([readRow(4, 'get_ticket'), readRow(9, 'fetch_page')]), room(470), pen)).toEqual({ flip: true, per: 2, rh: 18 * 7 + 12, cw: 128, w: 0 });
  });

  it('turns only under 560px of its own room', () => {
    expect(fitMatrix(grid(3, 6), room(559), pen).flip).toBe(true);
    expect(fitMatrix(grid(3, 6), room(560), pen)).toEqual({ flip: false, per: 6, rh: 96, cw: 98, w: 96 + 6 * 102 });
    // nor before it is laid out
    expect(fitMatrix(grid(3, 6), { width: null, fallback: 500, narrow: false }, pen).flip).toBe(false);
  });

  it('never turns four rows, a matrix with groups, one with no more columns than rows, or one whose columns fit', () => {
    expect(fitMatrix(grid(4, 6), room(500), pen).flip).toBe(false);
    expect(fitMatrix(grid(3, 3), room(300), pen)).toEqual({ flip: false, per: 3, rh: 96, cw: 98, w: 96 + 3 * 102 });
    expect(fitMatrix(grid(1, 2), room(400), pen)).toEqual({ flip: false, per: 2, rh: 96, cw: 98, w: 0 });
    const grouped = injection([{ key: 'g:get_ticket', label: 'get_ticket · 9 reads', parts: ['get_ticket', '9 reads'], rows: [] }]);
    expect(fitMatrix(grouped, room(400), pen).flip).toBe(false);
  });

  it('turns only where its rows get 112px each, or what their cells need where that is less', () => {
    // "120 of 120 passed" makes the cells 116px: three need 112px each beside the 96px heads
    expect(fitMatrix(grid(3, 6, '120 of 120 passed'), room(431), pen).flip).toBe(false);
    expect(fitMatrix(grid(3, 6, '120 of 120 passed'), room(433), pen)).toEqual({ flip: true, per: 3, rh: 96, cw: 108, w: 0 });
  });
});

/** A read and its worst attempt. */
const read = (callNo: number, name: string, worst: Worst): ReadRow => ({ callNo, name, worst, row: readRow(callNo, name) });

/** 42 reads, as a test finds them: get_ticket's, three of which did something, among fetch_page's, none of which did (4: every payload ran and was ignored). */
function fortyTwo(): ReadRow[] {
  const out: ReadRow[] = [];
  for (let n = 4; n < 4 + 42 * 4; n += 4) out.push(n % 8 === 0 ? read(n, 'fetch_page', 4) : read(n, 'get_ticket', n === 12 ? 0 : n === 28 ? 2 : n === 36 ? 1 : 4));
  return out;
}

describe('groups per tool', () => {
  it('lists eight reads or fewer each on its own row', () => {
    const eight = Array.from({ length: 8 }, (_, i) => read(i + 1, 'get_ticket', 4));
    expect(groupRows(eight).map((r) => r.label)).toEqual(eight.map((r) => r.row.label));
  });

  it('groups more by tool in the order first read, each head naming its tool and its count', () => {
    const rows = groupRows(fortyTwo());
    expect(rows.map((r) => [r.key, r.label, r.parts, r.sub])).toEqual([
      ['g:get_ticket', 'get_ticket · 21 reads', ['get_ticket', '21 reads'], 'config'],
      ['g:fetch_page', 'fetch_page · 21 reads', ['fetch_page', '21 reads'], 'config'],
    ]);
  });

  it('opens to the reads that did something, worst first then by number, each by its number alone, then one line for the rest', () => {
    const [ticket, page] = groupRows(fortyTwo());
    expect(ticket.rows!.map((r) => [r.label, r.name ?? null, r.href ?? null, r.sub ?? null, r.note ?? null])).toEqual([
      ['#12', '#12 get_ticket', `#/run/${RUN}/12`, null, null],
      ['#36', '#36 get_ticket', `#/run/${RUN}/36`, null, null],
      ['#28', '#28 get_ticket', `#/run/${RUN}/28`, null, null],
      ['', null, null, null, '18 more reads, every one ignored'],
    ]);
    expect(page.rows!.map((r) => r.note)).toEqual(['every read ignored every payload']);
  });

  it('never counts a read no attempt ran at as ignored: it lists one a payload never ran at, and says how many weren’t run', () => {
    // A test its budget stopped: #4 obeyed, #8 had one payload of two, #12 to #20 ignored every payload, #24 to #36 weren't reached.
    const reads = [read(4, 'get_ticket', 0), read(8, 'get_ticket', 3), ...[12, 16, 20].map((n) => read(n, 'get_ticket', 4)), ...[24, 28, 32, 36].map((n) => read(n, 'get_ticket', 5))];
    const [ticket] = groupRows(reads);
    expect(ticket.rows!.map((r) => r.note ?? r.label)).toEqual(['#4', '#8', '3 more reads, every one ignored; 4 not run']);
    expect(groupRows(reads.filter((r) => r.worst !== 4), { many: 4 })[0].rows!.map((r) => r.note ?? r.label)).toEqual(['#4', '#8', '4 more reads, none run']);
    expect([quietNote(false, 0, 9), quietNote(false, 5, 4), quietNote(false, 5, 0), quietNote(true, 5, 0)]).toEqual(['9 reads, none run', '5 reads ignored every payload; 4 not run', 'every read ignored every payload', '5 more reads, every one ignored']);
  });

  it('has no line for the rest where every read did something', () => {
    const loud = Array.from({ length: 9 }, (_, i) => read(i + 1, 'get_ticket', 1));
    const [only] = groupRows(loud);
    expect(only.rows!.some((r) => r.note)).toBe(false);
    expect(only.rows).toHaveLength(9);
  });

  it('keeps a matrix’s groups open until the page loads again, the tests forgetting them', () => {
    toggleGroup('inj-01K5CQ', 'g:get_ticket');
    toggleGroup('inj-01K5CQ', 'g:fetch_page');
    toggleGroup('inj-01K5CQ', 'g:fetch_page');
    toggleGroup('other', 'g:get_ticket');
    expect(openGroups('inj-01K5CQ')).toEqual(['g:get_ticket']);
    const m = injection(groupRows(fortyTwo()));
    const html = () => renderToStaticMarkup(createElement(ResultsMatrix, { matrix: m }));
    expect(html()).toContain('aria-expanded="true"');
    // drawn anew (the panel closed and opened), it is still open
    expect(html()).toContain('18 more reads, every one ignored');
    resetMatrixState();
    expect(openGroups('inj-01K5CQ')).toEqual([]);
    expect(html()).not.toContain('18 more reads');
  });
});

describe('a cell’s tone and words', () => {
  it('takes its word’s tone as a status does, in the four a cell draws', () => {
    const words = ['obeyed', 'caused', 'failed', 'influenced', 'inconclusive', 'passed', 'ignored', 'not caused', 'not applicable'];
    expect(words.map((word) => cellTone({ word }))).toEqual(['err', 'err', 'err', 'warn', 'warn', 'ok', 'mu', 'mu', 'mu']);
    // a fork's stubbed and blocked, a status's own tones, read muted in a cell
    expect(['stubbed', 'blocked', 'open'].map((word) => cellTone({ word }))).toEqual(['mu', 'mu', 'mu']);
    expect(cellTone({ word: 'ignored', tone: 'warn' })).toBe('warn');
    expect(TONE_COLOUR).toEqual({ err: 'var(--cq-red)', warn: 'var(--cq-amber)', ok: 'var(--cq-lime)', mu: 'var(--cq-muted)' });
  });

  it('keeps a bound whole, a range breaking only before “to”', () => {
    expect(glueBound('rate >= 0.60 (90%)')).toBe('rate\u00a0>=\u00a00.60\u00a0(90%)');
    expect(glueBound('rate <= 0.30 (90%)')).toBe('rate\u00a0<=\u00a00.30\u00a0(90%)');
    expect(glueBound('rate 0.50 to 0.96 (90%)')).toBe('rate\u00a00.50 to\u00a00.96\u00a0(90%)');
  });

  it('names a cell by where it is, then its word, tally and bound; one where nothing ran “not run”', () => {
    const m = injection([readRow(4, 'get_ticket')]);
    const [row] = m.rows;
    const col = m.cols[0];
    expect(cellName(m, row, col, { word: 'obeyed', tally: '3 of 3 obeyed' })).toBe('#4 get_ticket, system-notice: obeyed, 3 of 3 obeyed');
    expect(cellName(m, row, col, null)).toBe('#4 get_ticket, system-notice: not run');
    // a group's member goes by its name, which keeps its tool
    expect(cellName(m, { key: '4', label: '#4', name: '#4 get_ticket' }, col, { word: 'influenced', tally: '1 of 3 influenced' })).toBe('#4 get_ticket, system-notice: influenced, 1 of 3 influenced');
  });

  it('leaves the row out of a cell’s name where the matrix’s own name says it', () => {
    const m = presets();
    expect(cellName(m, m.rows[0], m.cols[0], { word: 'passed', tally: '5 of 6 passed', bound: 'rate >= 0.60 (90%)' })).toBe('tool timeout: passed, 5 of 6 passed, rate\u00a0>=\u00a00.60\u00a0(90%)');
  });
});

describe('the key’s lines', () => {
  const e = (words: string, n: number) => ({ words, n });

  it('puts what matters first, what showed nothing on a line of its own, and leaves out a count of zero', () => {
    const lines = keyLines([e('obeyed', 8), e('influenced', 0), e('inconclusive', 3)], [e('ignored', 59), e('not caused', 2)]);
    expect(lines.first.map((x) => [x.entry.words, x.quiet])).toEqual([
      ['obeyed', false],
      ['inconclusive', false],
    ]);
    expect(lines.second.map((x) => x.words)).toEqual(['ignored', 'not caused']);
  });

  it('ends the first line with a lone quieter entry, which keeps its quiet form', () => {
    const lines = keyLines([e('obeyed', 8), e('influenced', 2)], [e('ignored', 59)]);
    expect(lines.first.map((x) => [x.entry.words, x.quiet])).toEqual([
      ['obeyed', false],
      ['influenced', false],
      ['ignored', true],
    ]);
    expect(lines.second).toEqual([]);
  });

  it('lets the quieter entries take the first line where nothing that matters is left', () => {
    const lines = keyLines([e('obeyed', 0)], [e('ignored', 72), e('not caused', 1)]);
    expect(lines.first.map((x) => [x.entry.words, x.quiet])).toEqual([
      ['ignored', false],
      ['not caused', false],
    ]);
    expect(lines.second).toEqual([]);
  });

  it('splits a results key’s counts: what showed nothing quieter, passed with the verdicts', () => {
    const inj = resultsKey([['obeyed', 8], ['influenced', 2], ['inconclusive', 3], ['ignored', 59]]);
    expect(inj.main.map((x) => [x.words, x.n, x.tone])).toEqual([
      ['obeyed', 8, 'err'],
      ['influenced', 2, 'warn'],
      ['inconclusive', 3, 'warn'],
    ]);
    expect(inj.quiet.map((x) => [x.words, x.n, x.tone])).toEqual([['ignored', 59, 'mu']]);
    const pre = resultsKey([['failed', 2], ['inconclusive', 1], ['passed', 3], ['not applicable', 1]]);
    expect(pre.main.map((x) => x.words)).toEqual(['failed', 'inconclusive', 'passed']);
    expect(pre.quiet.map((x) => x.words)).toEqual(['not applicable']);
  });

  it('starts where the cells start while the columns that show hold its first line, else across the whole width', () => {
    const fit = { flip: false, per: 6, rh: 96, cw: 98, w: 0 };
    // six columns of 102px show in 1100px: 612px hold 80 + 90 + 100 with 26px around each
    expect(keyStart(fit, 6, 1100, [80, 90, 100])).toBe(100);
    expect(keyStart(fit, 6, 1100, [300, 300])).toBe(0);
    // two columns show in 300px
    expect(keyStart(fit, 6, 300, [80, 90])).toBe(0);
    expect(keyStart({ ...fit, flip: true }, 6, 1100, [80])).toBe(0);
    expect(keyStart(fit, 6, null, [80])).toBe(0);
  });
});

/** How many of the markup's elements have a class. */
function classes(html: string, cls: string): number {
  return [...html.matchAll(/class="([^"]*)"/g)].filter((m) => m[1].split(' ').includes(cls)).length;
}

describe('the matrix drawn', () => {
  it('draws a group with the cells of a run’s presets, a link each to its attempt, read by its text', () => {
    const m = presets((c) => (c.key === 'empty' ? null : { word: c.key === '429' ? 'failed' : 'passed', tally: '5 of 6 passed', bound: 'rate >= 0.60 (90%)', href: `#/run/01K5CQ4N7X/${c.key === '429' ? 5 : 4}` }));
    const html = renderToStaticMarkup(createElement(ResultsMatrix, { matrix: m }));
    expect(html).toMatch(/^<div class="rmx" role="group" aria-label="Error-path presets on 01K5CQ4N7G" data-rmxfit="b6:/);
    expect(html).toContain('<span class="rmx-k">run</span>');
    expect(classes(html, 'rmx-ch')).toBe(6);
    expect(html).toContain('<a class="rmx-c err" href="#/run/01K5CQ4N7X/5" data-at="01K5CQ4N7G|429"><i aria-hidden="true"></i><span class="sr">provider 429: </span><b>failed</b><span class="sr">, </span><span class="rmx-tally">5 of 6 passed</span><span class="sr">, </span><small>rate\u00a0&gt;=\u00a00.60\u00a0(90%)</small></a>');
    expect(html).toContain('<span class="rmx-c none" data-at="01K5CQ4N7G|empty"><i aria-hidden="true"></i><span class="sr">empty result: </span><b>not run</b></span>');
    expect(classes(html, 'ok')).toBe(4);
  });

  it('wraps a matrix of one row into balanced bands, the corner on the first, empty places keeping the last band’s cells in line', async () => {
    // before it is laid out, the window's room: 500px wide leaves 320 for the matrix, two columns a band
    vi.stubGlobal('innerWidth', 500);
    const m = presets(undefined, {}, PRESET_COLS.slice(0, 5));
    const html = renderToStaticMarkup(createElement(ResultsMatrix, { matrix: m }));
    expect(classes(html, 'rmx-band')).toBe(3);
    expect([...html.matchAll(/<span class="rmx-k">([^<]*)<\/span>/g)].map((x) => x[1])).toEqual(['run', '', '']);
    // the last band has one column of two: an empty place after its head and after its cell
    expect(classes(html, 'rmx-fill')).toBe(2);
    expect(html).toContain('style="--n:2;--rh:96px;--cw:100px"');
  });

  it('draws a column’s card from what the variant does, a cell with a card and no link as a stop of its own', () => {
    const cols = [{ key: 'system-notice', label: 'system-notice', sub: 'Poses as a system notice: SYSTEM NOTICE: …' }];
    const m = injection([readRow(4, 'get_ticket')], () => ({ word: 'obeyed', tally: '3 of 3 obeyed', tip: '{"t":"#4 get_ticket · system-notice"}' }));
    const html = renderToStaticMarkup(createElement(ResultsMatrix, { matrix: { ...m, cols } }));
    expect(html).toContain(`<span class="rmx-ch" data-tip="${JSON.stringify({ t: 'system-notice', s: 'Poses as a system notice: SYSTEM NOTICE: …' }).replace(/"/g, '&quot;')}">system-notice</span>`);
    expect(html).toContain('<span class="rmx-c err" data-tip="{&quot;t&quot;:&quot;#4 get_ticket · system-notice&quot;}" data-at="4|system-notice" tabindex="0">');
    // a read's head goes to its call, its number muted, where its reads come from under it
    expect(html).toContain(`<span class="rmx-r"><a class="rmx-rb" href="#/run/${RUN}/4"><span class="rmx-cn">#4</span> get_ticket</a><small>config</small></span>`);
  });

  it('draws a tool’s group as a button that opens it, its count apart on a phone, each member by its number and read by its tool', () => {
    toggleGroup('inj-01K5CQ', 'g:get_ticket');
    const html = renderToStaticMarkup(createElement(ResultsMatrix, { matrix: injection(groupRows(fortyTwo())) }));
    expect(html).toContain(
      '<button class="rmx-g" type="button" data-at="g|g:get_ticket" aria-expanded="true"><svg aria-hidden="true"><use href="#i-caret"></use></svg><span><span class="rmxl">get_ticket<span class="rmxsep">\u00a0·</span></span> <span class="rmxl">21 reads</span></span></button><small>config</small>',
    );
    expect(html).toContain(`<span class="rmx-r rmx-sub"><a class="rmx-rb rmx-rn" href="#/run/${RUN}/12"><span class="rmx-cn">#12</span><span class="sr"> get_ticket</span></a></span>`);
    expect(html).toContain('<span class="rmx-note"><span>18 more reads, every one ignored</span></span>');
    expect(html).toContain('<button class="rmx-g" type="button" data-at="g|g:fetch_page" aria-expanded="false">');
    // a member's cells are named by its tool too
    expect(html).toContain('<span class="sr">#12 get_ticket, system-notice: </span>');
  });

  it('draws the key in its head where it is given one', () => {
    const keys = { main: resultsKey([['obeyed', 8]]).main, quiet: [] };
    const html = renderToStaticMarkup(createElement(ResultsMatrix, { matrix: presets(), keys }));
    expect(html).toMatch(/style="--rhk:0px"><div class="rmx-key0"><div class="mxkey"><p class="mxk1">/);
  });
});

describe('the key drawn', () => {
  it('sets a figure and its words apart with a space a screen reader says, each entry’s swatch in its tone, the lone quiet entry last', () => {
    const k = resultsKey([['obeyed', 8], ['influenced', 2], ['inconclusive', 0], ['ignored', 1059]]);
    const html = renderToStaticMarkup(createElement(MatrixKey, k));
    expect(html).toContain('<span class="mxk"><i class="mxsw err" aria-hidden="true"></i><b>8<span class="srsp"><span class="sr"> </span></span></b>obeyed</span>');
    expect(html).toContain('<span class="mxk q"><i class="mxsw mu" aria-hidden="true"></i><b>1,059<span class="srsp"><span class="sr"> </span></span></b>ignored</span>');
    expect(html).not.toContain('inconclusive');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('mxk2');
    // a key is a legend, which marks its terms: influenced
    expect(html).toMatch(/data-term="influenced"/);
  });

  it('gives an entry with a card the focus, and draws the page’s own swatch', () => {
    const sw = createElement('i', { className: 'dg w', 'aria-hidden': 'true' });
    const html = renderToStaticMarkup(createElement(MatrixKey, { main: [{ n: 2, words: 'writes changed', sw, tip: '{"t":"Split"}' }], quiet: [{ n: 47, words: 'the same' }, { n: 4, words: 'left as recorded' }] }));
    expect(html).toContain('<span class="mxk" tabindex="0" data-tip="{&quot;t&quot;:&quot;Split&quot;}"><i class="dg w" aria-hidden="true"></i>');
    expect(html).toMatch(/<p class="mxk2"><span class="mxk q">.*the same<\/span> <span class="mxk q">.*left as recorded<\/span><\/p>/);
  });

  it('draws nothing where every count is zero', () => {
    expect(renderToStaticMarkup(createElement(MatrixKey, resultsKey([['failed', 0]])))).toBe('');
  });
});

describe('the receipt and the panel', () => {
  it('draws the receipt’s first line louder than the rest, each a line of dotted parts, a line with a card a stop of its own', () => {
    const html = renderToStaticMarkup(createElement(Receipt, { lines: [{ parts: ['this test spent ≈$3.11', 'every call before a read replayed free'], tip: '{"t":"Cost"}' }, { parts: ['819 upstream requests', '6 clean replays to compare with'] }, { parts: [] }] }));
    expect(html).toBe(
      '<div class="mxfoot"><p class="mxr" data-tip="{&quot;t&quot;:&quot;Cost&quot;}" tabindex="0"><span class="nw">this test spent ≈$3.11\u00a0·</span> <span class="nw">every call before a read replayed free</span></p><p class="mxr q"><span class="nw">819 upstream requests\u00a0·</span> <span class="nw">6 clean replays to compare with</span></p></div>',
    );
  });

  const panel = (o: Partial<Parameters<typeof FindingPanel>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(FindingPanel, {
        kind: 'presets',
        name: 'Error-path preset results',
        label: 'Run × presets',
        meta: ['6 presets', 'at get_ticket (#4) and model call #5', 'just now'],
        cmd: `shadowlap chaos ${RUN} --presets`,
        matrix: presets(),
        keys: resultsKey([['failed', 2], ['passed', 4]]),
        line: ['gate: tells 90%+ from 50%- at <= 10% risk, up to 6 attempts', null, createElement('span', { 'data-tip': '{"t":"The checks","s":"chaos.expect"}' }, 'checks: issue_refund called 0 times')],
        receipt: [{ parts: ['these presets spent ≈$0.486'] }, { parts: ['132 upstream requests'] }],
        ...o,
      }),
    );

  it('heads the panel with the matrix’s name, what was tried, where and when, and the command with no prompt and no card', () => {
    const html = panel();
    expect(html).toMatch(/^<section class="rmxp" data-kind="presets" aria-label="Error-path preset results"><div class="rmxp-h"><span class="rmxp-t">Run × presets<\/span><span class="rmxp-meta"><span class="nw">6 presets\u00a0·<\/span> <span class="nw">at get_ticket \(#4\) and model call #5\u00a0·<\/span> <span class="nw">just now<\/span><\/span><span class="rmxp-cmd"><code class="ts-cmd">/);
    expect(html.match(/<code/g)).toHaveLength(1);
    expect(html).not.toMatch(/rmxp-cmd[^>]*title=/);
    expect(html).not.toMatch(/<b[^>]*>\$\s*<\/b>/);
    // the matrix's script hasn't come: it waits in its place, its live region there and empty as it is first drawn
    expect(html).toContain('<section class="skel" aria-busy="true"><span class="said"><span class="sr" role="status"></span></span><div class="skbars"');
  });

  it('draws the rule and the checks on one line, the dot kept with the part before it, and the receipt at the foot', () => {
    const html = panel();
    expect(html).toContain('<p class="rmxp-line"><span class="rmxl">gate: tells 90%+ from 50%- at &lt;= 10% risk, up to 6 attempts<span class="rmxsep">\u00a0·</span></span> <span class="rmxl"><span data-tip="{&quot;t&quot;:&quot;The checks&quot;,&quot;s&quot;:&quot;chaos.expect&quot;}">checks: issue_refund called 0 times</span></span></p>');
    expect(html).toMatch(/<div class="mxfoot"><p class="mxr"><span class="nw">these presets spent ≈\$0.486<\/span><\/p><p class="mxr q">/);
  });

  it('says why in the matrix’s place where no attempt ran, with no key, its script never asked for', () => {
    const html = panel({ matrix: null, none: 'No attempt ran: the budget of $25.00 is spent. 13 clean replays ran first, as a test runs them.', line: [] });
    expect(html).toContain('<p class="rmxp-none">No attempt ran: the budget of $25.00 is spent. 13 clean replays ran first, as a test runs them.</p>');
    expect(html).not.toContain('mxkey');
    expect(html).not.toContain('rmxp-line');
    expect(html).not.toContain('Loading');
    expect(ResultsMatrixPart.script).toBe('idle');
  });

  it('waits for the matrix’s script as the results’ skeleton, and says so where it fails to come', async () => {
    const waiting = await render(MATRIX_STATES.waiting);
    try {
      expect(waiting.one('.skel > .said > [role="status"]').textContent).toBe('Loading the results…');
    } finally {
      await waiting.unmount();
    }
    expect(renderToStaticMarkup(createElement(AppContext.Provider, { value: app() }, MATRIX_STATES.failed))).toContain('This matrix’s code didn’t come from the dashboard server. Retry loads the page again.');
  });

  it('shows Show results on a finding while its results are closed', () => {
    expect(renderToStaticMarkup(createElement(ResultsToggle, { runId: RUN, which: 'presets' }))).toBe(
      '<button class="linkbtn" type="button" data-act="results" data-which="presets" aria-expanded="false" aria-controls="insp">Show results</button>',
    );
  });
});

describe('the matrix’s own script', () => {
  let r: Rendered | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
  });

  it('starts to load as the pointer reaches Show results, before the results open, so they show at once', async () => {
    expect(ResultsMatrixPart.script).toBe('idle');
    r = await render(createElement(ResultsToggle, { runId: RUN, which: 'presets', preload: () => ResultsMatrixPart.preload() }));
    expect(ResultsMatrixPart.script).toBe('idle');
    await r.hover(r.one('[data-act="results"]'));
    expect(ResultsMatrixPart.script).not.toBe('idle');
  });

  it('draws the matrix in the panel once its script comes, a group opening on its button', async () => {
    r = await render(createElement(FindingPanel, { kind: 'injection', name: 'Injection test results', label: 'Untrusted reads × payloads', meta: ['72 attempts'], cmd: `shadowlap injection ${RUN}`, matrix: injection(groupRows(fortyTwo())), receipt: [] }));
    await r.until('the matrix', () => r!.all('.rmx').length === 1);
    expect(r.all('.rmx-note')).toHaveLength(0);
    const button = r.one('[data-at="g|g:get_ticket"]');
    await r.click(button);
    expect(r.one('[data-at="g|g:get_ticket"]').getAttribute('aria-expanded')).toBe('true');
    expect(r.all('.rmx-note').map((n) => n.textContent)).toEqual(['18 more reads, every one ignored']);
    expect(r.one('.rmx').getAttribute('data-rmxfit')).toMatch(/:g:get_ticket$/);
  });
});
