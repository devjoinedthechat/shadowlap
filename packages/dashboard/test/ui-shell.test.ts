import { describe, expect, it } from 'vitest';
import { MAX_DATASET_RUNS } from '../src/run-exports.js';
import { BULK_MAX } from '../src/runs-list.js';
import { dialogFocus, trapTab } from '../ui/focus.js';
import { jobRunning } from '../ui/jobs.js';
import { knownParent, noteParent, onParentNoted } from '../ui/parents.js';
import { stripScroll } from '../ui/place.js';
import { exportedLine } from '../ui/projects.js';
import { BULK_BATCH, DATASET_MAX, datasetOff, inBatches, joinDeleted, joinLabelled, RM_ALL, rmCommand } from '../ui/runspage/bulk.js';
import { phoenixProjectNote, phoenixProjectOk, TRACE_COPY, traceIdOk } from '../ui/runspage/imports.js';
import { copyCompares } from '../ui/runs.js';
import { crumbLineage, crumbParent, liveChip, topPill } from '../ui/shell/top.js';
import { errorText, sentence, TOAST_MS } from '../ui/toast.js';

describe('a tab strip on a narrow screen', () => {
  // A strip 358px wide, scrolled to its start; tabs from the start of its content.
  const strip = { scrollLeft: 0, width: 358 };

  it('scrolls a tab that is off its right edge into view, a little clear of the edge', () => {
    expect(stripScroll(strip, { left: 468, width: 59 })).toBe(468 + 59 + 16 - 358);
  });

  it('scrolls back to a tab off its left edge, and to the start of a tab wider than the strip', () => {
    expect(stripScroll({ scrollLeft: 300, width: 358 }, { left: 120, width: 80 })).toBe(104);
    expect(stripScroll({ scrollLeft: 300, width: 358 }, { left: 8, width: 80 })).toBe(0);
    expect(stripScroll(strip, { left: 400, width: 500 })).toBe(384);
  });

  it('leaves a strip alone when its tab shows already', () => {
    expect(stripScroll(strip, { left: 0, width: 84 })).toBeNull();
    expect(stripScroll({ scrollLeft: 200, width: 358 }, { left: 300, width: 80 })).toBeNull();
  });
});

describe('an exported copy’s project block', () => {
  it('counts the runs it holds in words', () => {
    expect(exportedLine(1)).toBe('1 run · nothing runs from here');
    expect(exportedLine(2)).toBe('2 runs · nothing runs from here');
    expect(exportedLine(0)).toBe('0 runs · nothing runs from here');
  });

  it('has Compare only when it holds two runs or more', () => {
    expect(copyCompares(['01M51X7D66'])).toBe(false);
    expect(copyCompares(undefined)).toBe(false);
    expect(copyCompares(['01M51X7EDD', '01M51X7H8Q'])).toBe(true);
  });
});

describe('the bulk bar', () => {
  it('offers Dataset up to what one dataset takes, and says why not past it', () => {
    expect(DATASET_MAX).toBe(MAX_DATASET_RUNS);
    expect(datasetOff(500)).toBeNull();
    expect(datasetOff(612)).toBe('At most 500 runs go into one dataset: 612 are picked');
  });

  it('sends a thousand ids at a time to the bulk routes, and joins what they answer', async () => {
    expect(BULK_BATCH).toBe(BULK_MAX);
    const ids = Array.from({ length: 2500 }, (_, i) => `run${i}`);
    const sent: number[] = [];
    const parts = await inBatches(ids, async (part) => {
      sent.push(part.length);
      return { done: part.slice(0, 1).map((runId) => ({ runId, labels: ['good'] })), skipped: [{ runId: part.at(-1)!, reason: 'no such run' }] };
    });
    expect(sent).toEqual([1000, 1000, 500]);
    const labelled = joinLabelled(parts);
    expect(labelled.done.map((d) => d.runId)).toEqual(['run0', 'run1000', 'run2000']);
    expect(labelled.skipped.map((s) => s.runId)).toEqual(['run999', 'run1999', 'run2499']);
    expect(joinDeleted([
      { done: ['a'], attempts: ['a1'], skipped: [], blobs: 2, bytes: 10 },
      { done: ['b'], attempts: [], skipped: [{ runId: 'c', reason: 'still recording' }], blobs: 1, bytes: 5 },
    ])).toEqual({ done: ['a', 'b'], attempts: ['a1'], skipped: [{ runId: 'c', reason: 'still recording' }], blobs: 3, bytes: 15 });
  });

  it('prints every id a Delete of a few runs takes, and the first few and how many more for a long pick', () => {
    const ids = Array.from({ length: 1100 }, (_, i) => `01M5${String(i).padStart(6, '0')}ABCDEFGHJKMNPQ`);
    const few = rmCommand(ids.slice(0, RM_ALL));
    expect(few.shown).toBe(few.full);
    expect(few.full).toBe(`shadowlap rm ${ids.slice(0, RM_ALL).map((id) => id.slice(0, 10)).join(' ')}`);
    const long = rmCommand(ids);
    expect(long.shown).toBe('shadowlap rm 01M5000000 01M5000001 01M5000002 01M5000003 01M5000004 … and 1,095 more');
    expect(long.full.split(' ')).toHaveLength(2 + 1100);
    expect(long.full.endsWith(' 01M5001099')).toBe(true);
    expect(rmCommand(ids.slice(0, RM_ALL + 1)).shown).toMatch(/ … and 6 more$/);
  });
});

describe('dialogs', () => {
  it('start on the field, else on the action, but on Cancel when the action is red', () => {
    expect(dialogFocus('lime')).toEqual([expect.stringMatching(/^textarea, input.*select$/), '.dlg-alt', '.dlg-ok']);
    expect(dialogFocus(undefined)).toEqual([expect.stringMatching(/^textarea/), '.dlg-alt', '.dlg-ok']);
    expect(dialogFocus('danger')).toEqual(['.dlg-cancel']);
    // A finger's field would open the phone's keyboard over the dialog: it starts on the way on, else on Cancel.
    expect(dialogFocus('lime', undefined, true)).toEqual(['.dlg-alt', '.dlg-ok', '.dlg-cancel']);
    expect(dialogFocus('danger', undefined, true)).toEqual(['.dlg-cancel']);
  });

  it('start on Cancel whatever they hold when asked to', () => {
    expect(dialogFocus('lime', 'cancel')).toEqual(['.dlg-cancel']);
    expect(dialogFocus('danger', 'cancel')).toEqual(['.dlg-cancel']);
  });

  // aria-modal says the page behind can't be reached: Tab from Delete run went on to the strip's
  // cells behind the scrim, and Enter there opened another call with the dialog still open.
  it('keep Tab among their own controls, round from the last to the first and back', () => {
    const controls = ['Cancel', 'Delete run'];
    expect(trapTab(controls, 'Delete run', false)).toBe('Cancel');
    expect(trapTab(controls, 'Cancel', true)).toBe('Delete run');
    // Within them, the browser's own step stays inside.
    expect(trapTab(controls, 'Cancel', false)).toBeNull();
    expect(trapTab(controls, 'Delete run', true)).toBeNull();
    // A focus left on the page behind, or on nothing, comes back in.
    expect(trapTab(controls, null, false)).toBe('Cancel');
    expect(trapTab(controls, null, true)).toBe('Delete run');
    // The shortcuts have one control: Tab stays on it.
    expect(trapTab(['Close'], 'Close', false)).toBe('Close');
    expect(trapTab([], null, false)).toBe('self');
  });
});

describe('the top bar', () => {
  const RO = 'This dashboard is read-only (started with --read-only): it shows runs and changes nothing.';
  const EMBEDDED = 'This dashboard is read-only: start it with shadowlap dashboard to change runs and run actions.';

  it('says what kind of dashboard it is in the pill, with why on hover', () => {
    expect(topPill({ exported: true, readOnly: false, actionsOff: 'This is an exported copy: nothing runs from here.', store: null })).toEqual({ word: 'exported', title: 'This is an exported copy: nothing runs from here.' });
    expect(topPill({ exported: false, readOnly: true, actionsOff: RO, store: null })).toEqual({ word: 'read-only', title: RO });
    // Embedded without the CLI: nothing was started with --read-only, and the title says what was.
    expect(topPill({ exported: false, readOnly: true, actionsOff: EMBEDDED, store: null })).toEqual({ word: 'read-only', title: EMBEDDED });
    // What it is, the store the project shares: never a word that reads as a plan tier.
    expect(topPill({ exported: false, readOnly: false, actionsOff: null, store: 's3://northwind-agent-runs/support-agent' })).toEqual({ word: 'team store', title: 'Runs push to and pull from the team store s3://northwind-agent-runs/support-agent' });
    // Read-only wins the word; the title still names the team store.
    expect(topPill({ exported: false, readOnly: true, actionsOff: RO, store: 's3://northwind-agent-runs/support-agent' })).toEqual({ word: 'read-only', title: `${RO} · team store s3://northwind-agent-runs/support-agent` });
    expect(topPill({ exported: false, readOnly: false, actionsOff: null, store: null })).toEqual({ word: 'dashboard', title: null });
    // A link that expired turns actions off, but the dashboard is no less a dashboard.
    expect(topPill({ exported: false, readOnly: false, actionsOff: 'This link has expired.', store: null }).word).toBe('dashboard');
  });

  it('names a run’s parent from the run list, else from the detail its page loaded, and only runs a copy holds', () => {
    const holds = (id: string) => id === '01M51X7EDD';
    expect(crumbParent({ listed: { parentRunId: '01M51X7EDD' }, loaded: undefined, exported: false, holds })).toBe('01M51X7EDD');
    expect(crumbParent({ listed: { parentRunId: null }, loaded: '01M51X7EDD', exported: false, holds })).toBeNull();
    // An attempt the list leaves out: nothing until its page has loaded it, then its parent.
    expect(crumbParent({ listed: null, loaded: undefined, exported: false, holds })).toBeNull();
    expect(crumbParent({ listed: null, loaded: '01M51X7EDD', exported: false, holds })).toBe('01M51X7EDD');
    expect(crumbParent({ listed: null, loaded: null, exported: false, holds })).toBeNull();
    expect(crumbParent({ listed: { parentRunId: '01M51X7H8Q' }, loaded: undefined, exported: true, holds })).toBeNull();
    expect(crumbParent({ listed: { parentRunId: '01M51X7EDD' }, loaded: undefined, exported: true, holds })).toBe('01M51X7EDD');
  });

  it('carries a run’s whole lineage in its crumbs, oldest first, each with its about line for the hover', () => {
    // A fork of a fork of a recording: the crumbs read Runs / recording / fork / this run.
    const runs = new Map([
      ['REC', { parentRunId: null, about: { text: 'Ticket T-8812 arrived damaged' } }],
      ['FORK', { parentRunId: 'REC', about: { text: 'lookup_policy live #16' } }],
      ['THIS', { parentRunId: 'FORK', about: { text: 'HTTP 529 #19' } }],
    ]);
    const o = { listed: (id: string) => runs.get(id) ?? null, loaded: () => undefined, exported: false, holds: (id: string) => runs.has(id) };
    expect(crumbLineage('THIS', o)).toEqual([
      { runId: 'REC', about: 'Ticket T-8812 arrived damaged' },
      { runId: 'FORK', about: 'lookup_policy live #16' },
    ]);
    expect(crumbLineage('REC', o)).toEqual([]);
    // An attempt the list leaves out names its parent once its page loaded it; past a run nobody knows, the lineage stops.
    expect(crumbLineage('ATTEMPT', { ...o, loaded: (id) => (id === 'ATTEMPT' ? 'THIS' : undefined) }).map((a) => a.runId)).toEqual(['REC', 'FORK', 'THIS']);
    expect(crumbLineage('LOST', { ...o, listed: (id) => (id === 'LOST' ? { parentRunId: 'GONE' } : null) }).map((a) => a.runId)).toEqual(['GONE']);
    // An exported copy links only to the runs it holds.
    expect(crumbLineage('THIS', { ...o, exported: true, holds: (id) => id !== 'REC' }).map((a) => a.runId)).toEqual(['FORK']);
  });

  it('keeps the parents of the runs loaded, and says when it learns one', () => {
    let heard = 0;
    const stop = onParentNoted(() => heard++);
    expect(knownParent('01M528J9G5')).toBeUndefined();
    noteParent(['01M528J9G5', '01M528J9G5XXXXXXXXXXXXXXXX'], '01M51X7EDD');
    expect(knownParent('01M528J9G5')).toBe('01M51X7EDD');
    expect(knownParent('01M528J9G5XXXXXXXXXXXXXXXX')).toBe('01M51X7EDD');
    noteParent(['01M528J9G5'], '01M51X7EDD');
    expect(heard).toBe(1);
    noteParent(['01M51X7EDD'], null);
    expect(knownParent('01M51X7EDD')).toBeNull();
    expect(heard).toBe(2);
    stop();
    noteParent(['01M528JDY1'], '01M51X7EDD');
    expect(heard).toBe(2);
  });

  it('keeps a recording’s chip while offline, saying when it was last heard of, as the design does', () => {
    const at = new Date(2026, 9, 16, 14, 2).getTime();
    expect(liveChip({ recording: '01M51XRN57', conn: 'ok', loadedAt: at })).toEqual({ runId: '01M51XRN57', title: null });
    expect(liveChip({ recording: '01M51XRN57', conn: 'offline', loadedAt: at })).toEqual({ runId: '01M51XRN57', title: 'Recording when last heard of, at 14:02: live updates are paused' });
    expect(liveChip({ recording: '01M51XRN57', conn: 'expired', loadedAt: at })).toBeNull();
    expect(liveChip({ recording: null, conn: 'ok', loadedAt: at })).toBeNull();
  });
});

describe('the palette', () => {
  it('offers no second test session while one started from the page runs', () => {
    const kinds = new Set(['test', 'test-update', 'normalize-and-test']);
    const job = (kind: string, done: boolean, lost?: boolean) => ({ job: { kind, done }, ...(lost === undefined ? {} : { lost }) });
    expect(jobRunning([], kinds)).toBe(false);
    expect(jobRunning([job('test', false)], kinds)).toBe(true);
    expect(jobRunning([job('normalize-and-test', false)], kinds)).toBe(true);
    expect(jobRunning([job('test', true)], kinds)).toBe(false);
    // The server was restarted and no longer has it: it isn't running from here.
    expect(jobRunning([job('test', false, true)], kinds)).toBe(false);
    expect(jobRunning([job('replay', false)], kinds)).toBe(false);
  });
});

describe('importing a trace', () => {
  it('names the format of a trace id instead of offering a made-up one', () => {
    expect(TRACE_COPY.langfuse.id).toBe('a UUID or 32 hex characters, from the trace’s page');
    expect(TRACE_COPY.langsmith.id).toBe('a UUID, from the trace’s page in LangSmith');
    expect(TRACE_COPY.phoenix.id).toBe('32 hex characters, from the trace’s page in Phoenix');
    expect(TRACE_COPY.logfire.id).toBe('32 hex characters, from the trace’s details in Logfire');
    for (const t of Object.values(TRACE_COPY)) expect(t.id).not.toMatch(/[0-9a-f]{8}/);
  });

  it('checks a trace id as its store writes it, and a Phoenix project as the CLI takes it', () => {
    expect(traceIdOk('langsmith', '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b3c')).toBe(true);
    expect(traceIdOk('phoenix', '0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b3c')).toBe(false);
    expect(traceIdOk('logfire', '01A16460E2F311342463057F62B79FA9')).toBe(true);
    expect(traceIdOk('phoenix', '01a16460e2f3113424630')).toBe(false);
    expect(phoenixProjectOk('support-agent')).toBe(true);
    for (const bad of ['', 'a/b', 'a?b', 'a#b', 'x'.repeat(201)]) expect(phoenixProjectOk(bad), bad).toBe(false);
  });

  it('says why a Phoenix project typed is not one, and nothing while the field is empty', () => {
    // Emptied, the field says nothing: Import waits for a project.
    for (const quiet of ['', '  ', 'support-agent']) expect(phoenixProjectNote(quiet), quiet).toBeNull();
    expect(phoenixProjectNote('support/agent')).toBe('That is not a project’s name or id: it holds no /, ? or #.');
    expect(phoenixProjectNote('x'.repeat(201))).toBe('That is not a project’s name or id: it is 200 characters at most.');
  });
});

describe('a toast that reports an error', () => {
  it('starts the server’s reason with a capital, and leaves a first word that is a name alone', () => {
    expect(errorText(new Error('the repairer in shadowlap.config.json changed since this page loaded: now anthropic. Nothing ran: open Repair from here again'))).toBe(
      'The repairer in shadowlap.config.json changed since this page loaded: now anthropic. Nothing ran: open Repair from here again',
    );
    expect(sentence('no run 01K5CQ9C4H')).toBe('No run 01K5CQ9C4H');
    expect(sentence('a run is recording: gc gives space back once it ends')).toBe('A run is recording: gc gives space back once it ends');
    for (const named of ['fx-01K5CQ4Z3F is applied already', 'runIds: pick the runs to push', 'baseUrl must be a URL', 'shadowlap.config.json changed', 'shadowlap store set needs a URL', '01K5CQ9C4H is still recording', 'Already a sentence.']) expect(sentence(named)).toBe(named);
    expect(errorText('plain text thrown')).toBe('Plain text thrown');
  });

  it('stays on screen longer than a notice', () => {
    expect(TOAST_MS.notice).toBe(2600);
    expect(TOAST_MS.error).toBeGreaterThanOrEqual(8000);
  });
});
