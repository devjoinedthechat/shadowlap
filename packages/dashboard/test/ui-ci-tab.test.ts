import { act, createElement, useMemo, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASELINE_DEFAULTS, COMMENT_FOOT, commentMarkdown, readWorkflow, RECORD_WINDOWS, workflowVersion } from '@shadowlap/engine';
import { fileSwitches, type RepositoryWorkflow } from '../src/ci-file.js';
import { ciWorkflows, fileOptions, parseCiOptions, type CiContext, type CiWorkflowOptions, type CiWorkflowsView } from '../src/ci-workflows.js';
import type { PrCommentPreview } from '../src/pr-comment-preview.js';
import { gatePreview } from '../src/tests-gate.js';
import { ApiError } from '../ui/api.js';
import { previewSub } from '../ui/ci/words.js';
import { tipCard } from '../ui/components/HoverCard.js';
import { PR_COMMENT_ASK } from '../ui/page-ask.js';
import { sessionLine } from '../ui/pages/settings/CiWorkflow.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { keptFor } from '../ui/pages/settings/ci-kept.js';
import { AppContext, type AppState } from '../ui/state.js';
import { styleRules } from './css-sheet.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';
import { withServed } from './ui-served-now.js';

/**
 * Settings → CI as the page renders the server's answers: Your workflow first, where the
 * repository's file stands against the one the switches build, folded behind Show workflow, with
 * Write file and its ask while the two differ; then Pull request comment, Fix on failure and Alerts,
 * each with its switch in its header and its own needs, a part that is off folded to one line and
 * each list behind its name and count; and Gates, a tab of its own, which previews a gate's figures.
 * The fake server answers as the routes do: the switches start from the repository's file, Write
 * file writes it, and its Undo puts it back.
 */

const goldens = [
  { path: 'goldens/refund-flow-budget', live: ['fork' as const], keys: ['ANTHROPIC_API_KEY'], known: true },
  { path: 'goldens/refund-over-limit', live: ['fork' as const], keys: ['ANTHROPIC_API_KEY'], known: true },
];
const FILE = '.github/workflows/agent.yml';
const GATES: NonNullable<CiContext['gates']> = { suiteRisk: 0.05, uses: { sprt: ['refund-flow-budget'], baseline: [] } };
const SESSION = { ci: false, revision: 'd2e8a1f0c4', at: Date.now() - 3_600_000, text: '2 of 7 goldens passed · 3 failed, 2 inconclusive' };

/** The comment's preview as `GET /api/ci/comment` answers it: a session that ran both goldens, with the decisions its job kept, a run's cost and an injection gate. */
const PREVIEW: PrCommentPreview = {
  session: { id: 'ts-01M5PREVIEW00000000000000A', revision: 'd2e8a1f+dirty', at: Date.now() - 3_600_000 },
  head: '1 of 2 goldens passed · 1 failed',
  rows: [
    { verdict: 'failed', golden: 'goldens/refund-over-limit', line: 'failed · diverged at call 3 · $.messages[2].content' },
    { verdict: 'passed', golden: 'goldens/refund-flow-budget', line: 'passed · replayed clean' },
  ],
  decisions: {
    sessionId: 'dc-01M5PREVIEW00000000000000',
    mark: '✗',
    sentence: '1 of 2 goldens decides a write or when to stop differently',
    headline: '1 of 2 goldens decides a write or when to stop differently, under the prompt and tools this pull request sends',
    rows: [
      { rank: 1, golden: 'goldens/refund-over-limit', callNo: 11, detail: 'add_note is no longer called; issue_refund is called', recorded: 'add_note({"order":"ord-1042","text":"over the limit"})', now: 'issue_refund({"order":"ord-1042","amount":240})' },
      { rank: 2, golden: 'goldens/refund-over-limit', callNo: 12, detail: 'ends the run', recorded: 'escalate({"to":"tier-2"})', now: 'text: Refunded.' },
    ],
    note: "Later steps are judged in the recorded run's state: shadowlap verify runs it end to end.",
  },
  cost: { before: 0.041, after: 0.043, line: '≈$0.041 → ≈$0.043 (+5%)', amounts: '≈$0.041 → ≈$0.043', change: '+5%' },
  injection: [{ verdict: 'passed', golden: 'goldens/refund-flow-budget', resultId: 'tr-01M5PREVIEW0000000000000B', line: 'passed · 6 attempts · 0 obeyed (at most 0 allowed) · 0 influenced · 6 ignored', tally: '6 attempts · 0 obeyed (at most 0 allowed) · 0 influenced · 6 ignored' }],
  postedBy: 'github-actions',
  foot: COMMENT_FOOT,
  markdown: '### Shadowlap: 1 of 2 goldens passed · 1 failed\n',
};

/** The repository's workflow as findWorkflow reads it, and the switches the reader takes from it. */
function repoOf(text: string | null): RepositoryWorkflow {
  const read = text === null ? null : readWorkflow(text);
  return { file: { path: FILE, exists: text !== null, version: workflowVersion(text), text: text ?? '', problem: null }, read, switches: read && !read.problem ? fileSwitches(read) : null };
}

/** The panels for the page's options, read as `GET /api/ci/workflows` reads them: over what the file sets. */
function served(o: Partial<CiWorkflowOptions>, text: string | null, over: Partial<CiContext> = {}): CiWorkflowsView {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) q.set(k, typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));
  const repo = repoOf(text);
  const options = parseCiOptions(q, fileOptions(repo.switches));
  if ('error' in options) throw new ApiError(400, options.error);
  return ciWorkflows(options, { preview: null, failing: 0, at: null, repository: null, branch: null, goldens, root: true, repo, gates: GATES, ...over });
}

/** The file Write file writes for the defaults: a repository whose workflow the switches start from as they are. */
const DEFAULTS_FILE = served({}, null).workflow.text;

/** A dashboard server holding the repository's workflow: Write file writes it, against the version read, and its Undo puts it back, against the version the write left. */
function fakeServer(start: string | null, over: Partial<CiContext> = {}) {
  const was = new Map<string, { text: string | null; version: string }>();
  const s = {
    text: start,
    preview: { session: null } as PrCommentPreview | { session: null },
    prComment: vi.fn(async () => s.preview),
    ciWorkflows: vi.fn(async (o: Partial<CiWorkflowOptions> = {}) => served(o, s.text, over)),
    writeWorkflow: vi.fn(async (o: Partial<CiWorkflowOptions>, expect: string) => {
      const view = served(o, s.text, over);
      if (expect !== view.version) throw new ApiError(409, `${FILE} changed since it was read`);
      const id = `w${was.size + 1}`;
      const before = s.text;
      s.text = view.workflow.text;
      was.set(id, { text: before, version: workflowVersion(s.text) });
      return { path: FILE, version: workflowVersion(s.text), changed: true, was: id };
    }),
    undoWorkflow: vi.fn(async (id: string) => {
      const kept = was.get(id);
      if (!kept || kept.version !== workflowVersion(s.text)) throw new ApiError(409, `${FILE} changed since it was read`);
      s.text = kept.text;
      return { path: FILE, version: workflowVersion(s.text), removed: s.text === null };
    }),
    // The preview as `GET /api/tests/gate` answers it, a figure the config refuses a 400 in parseGate's words.
    gate: vi.fn(async (query: string) => {
      try {
        return gatePreview(new URLSearchParams(query));
      } catch (err) {
        throw new ApiError(400, err instanceof Error ? err.message : String(err));
      }
    }),
  };
  return s;
}

function app(s: ReturnType<typeof fakeServer>, toast: AppState['toast'] = () => undefined, conn: AppState['conn'] = 'ok'): AppState {
  const client = { ciWorkflows: s.ciWorkflows, settings: { writeWorkflow: s.writeWorkflow, undoWorkflow: s.undoWorkflow, gate: s.gate, prComment: s.prComment }, teamStore: async () => null, jobs: async () => [], storeSetup: { view: async () => null } };
  return {
    client,
    conn,
    meta: { project: { id: 'support-agent', name: 'support-agent', path: '/work/support-agent' } },
    runs: [],
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast,
  } as unknown as AppState;
}

/** The address bar Gates reads a link's `?gate=` from, and puts back to the tab's own. */
let address = '#/settings/ci';
beforeEach(() => {
  address = '#/settings/ci';
  vi.stubGlobal('location', {
    pathname: '/',
    search: '',
    get hash() {
      return address;
    },
    set hash(to: string) {
      address = to;
    },
  });
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (address = url.slice(url.indexOf('#'))) });
});

// A history gate on its defaults takes the planner a few seconds the first time: worked out once here, then kept.
beforeAll(() => {
  gatePreview(new URLSearchParams('baseline=history&suiteRisk=0.05'));
  gatePreview(new URLSearchParams('suiteRisk=0.05'));
}, 60_000);

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

async function open(s: ReturnType<typeof fakeServer>, toast: AppState['toast'] = () => undefined, conn: AppState['conn'] = 'ok', tab = 'ci'): Promise<Rendered> {
  r = await render(createElement(AppContext.Provider, { value: app(s, toast, conn) }, withServed(createElement(SettingsPage, { tab }))));
  await r.until('the panels', () => r!.all('#alerts .cilist').length > 1);
  return r;
}

/** Gates, a tab of its own, with its preview drawn. */
async function openGates(s: ReturnType<typeof fakeServer>, conn: AppState['conn'] = 'ok'): Promise<Rendered> {
  r = await render(createElement(AppContext.Provider, { value: app(s, () => undefined, conn) }, withServed(createElement(SettingsPage, { tab: 'gates' }))));
  await r.until('the gate preview', () => r!.all('#gates .gsays').length === 1);
  return r;
}

/** The file Your workflow shows, without the marks a change leads its lines with: what Copy workflow copies. */
function shownFile(): string {
  const spans = r!.all('#wfBox pre.wfcode span');
  const marked = spans.some((x) => x.getAttribute('class'));
  return spans.map((x) => (marked ? x.textContent.slice(2) : x.textContent)).join('\n');
}

const plain = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ');

describe('Settings → CI', () => {
  it('lays the tab out as the design does: Your workflow, then a panel for each part with its switch in its header, and no gate’s figures, which are Gates’ own tab', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    const toast = vi.fn();
    // Alerts' old address opens the tab too.
    await open(s, toast, 'ok', 'alerts');
    expect(r!.all('.settab section.sec').map((x) => x.getAttribute('id'))).toEqual(['workflow', 'pr-comment', 'fix-on-failure', 'alerts']);
    expect(s.gate).not.toHaveBeenCalled();
    for (const [id, label] of [
      ['pr-comment', 'Pull request comment'],
      ['fix-on-failure', 'Fix on failure'],
      ['alerts', 'Alerts'],
    ]) {
      expect(r!.all(`#${id} header .switch[aria-label="${label}"]`)).toHaveLength(1);
    }
    expect(r!.one('#workflow header .sub').textContent.replace(/\u00a0/g, ' ')).toBe('built from the switches below');
    // The repository's file is the one the switches build: nothing to write.
    expect(plain(r!.one('#workflow .wfstate'))).toBe(`The same as your repository’s ${FILE}.`);
    expect(r!.all('#workflow header .btn')).toHaveLength(0);
    // The file folds behind Show workflow, the panel's last line, right over the box it opens, with Copy workflow beside it, its one copy icon CopyButton's own.
    const lines = r!.all('#workflow > .pbody')[0].children;
    expect([lines[lines.length - 1].className, r!.all('#workflow > .pbody').map((x) => x.getAttribute('id'))]).toEqual(['wftog', [null, 'wfBox']]);
    const show = r!.one('#workflow .wftog button[aria-controls="wfBox"]');
    expect([show.textContent, show.getAttribute('aria-expanded'), r!.one('#wfBox').hasAttribute('hidden')]).toEqual(['Show workflow', 'false', true]);
    expect(r!.byText('#workflow .wftog button', 'Copy workflow').querySelectorAll('svg')).toHaveLength(1);
    await r!.click(show);
    expect([show.textContent, show.getAttribute('aria-expanded'), r!.one('#wfBox').hasAttribute('hidden')]).toEqual(['Hide workflow', 'true', false]);
    expect(r!.all('#wfBox pre.wfcode span.add, #wfBox pre.wfcode span.del')).toHaveLength(0);
    expect(shownFile()).toBe(DEFAULTS_FILE.replace(/\n$/, ''));
    // Fix on failure on: the toast waits for the answer, which says the file now differs, each line it changes marked.
    expect(r!.one('#fix-on-failure').className).toBe('panel sec set cip off');
    await r!.click(r!.one('#fix-on-failure header .switch'));
    await r!.until('the toast for the answer', () => toast.mock.calls.length > 0);
    expect(s.ciWorkflows).toHaveBeenLastCalledWith(expect.objectContaining({ fix: true }));
    expect(toast).toHaveBeenCalledWith('Fix on failure is on · Your workflow changes with it');
    expect(r!.one('#fix-on-failure').className).toBe('panel sec set cip');
    // The panel drawn again for the answer keeps the focus on its switch.
    expect(r!.focused()).toBe(r!.one('#fix-on-failure header .switch'));
    const want = served({ fix: true }, DEFAULTS_FILE).workflow;
    expect(want.added).toBeGreaterThan(0);
    expect(r!.all('#wfBox pre.wfcode span.add')).toHaveLength(want.added);
    expect(r!.all('#wfBox pre.wfcode span.del')).toHaveLength(want.removed);
    expect(r!.all('#wfBox pre.wfcode span.add')[0].textContent).toMatch(/^\+ /);
    expect(shownFile()).toContain('fix-on-failure: true');
    // One action step still, the fix's inputs beside its own.
    expect(shownFile().match(/- uses: devjoinedthechat\/shadowlap@/g)).toHaveLength(1);
    // The counts in amber, each kept whole, then Write file in the header.
    const state = r!.one('#workflow .wfstate');
    expect(plain(state)).toMatch(/^\d+ lines? added( and \d+ lines? taken out)? against your repository’s file\. Write it, then commit it\.$/);
    expect(state.querySelector('b')!.textContent).toContain(`${want.added}${String.fromCharCode(160)}`);
    const write = r!.byText('#workflow header .btn', 'Write file');
    expect(write.getAttribute('class')).toContain('lime');
    await r!.click(write);
    expect(r!.one('[role="dialog"] header h3').textContent).toBe(`Write ${FILE}?`);
    expect(r!.all('[role="dialog"] header p span')[0].textContent).toBe('Changes the workflow in your repository to match the switches.');
    await r!.click(r!.one('[role="dialog"] .dlg-cancel'));
    expect(s.writeWorkflow).not.toHaveBeenCalled();
    // Off again: the file is the repository's once more, and the toast says so.
    await r!.click(r!.one('#fix-on-failure header .switch'));
    await r!.until('the toast for the file as it was', () => toast.mock.calls.length > 1);
    expect(toast).toHaveBeenLastCalledWith('Fix on failure is off · Your workflow is your repository’s again');
    expect(plain(r!.one('#workflow .wfstate'))).toBe(`The same as your repository’s ${FILE}.`);
    expect(r!.all('#wfBox pre.wfcode span.add')).toHaveLength(0);
  });

  it('folds a part that is off to what happens without it, which Show settings opens for a look and its switch for good, and each list behind its name and count', async () => {
    await open(fakeServer(DEFAULTS_FILE));
    const fix = () => r!.one('#fix-on-failure');
    const body = () => r!.one('#fix-on-failure .alertgrid');
    const show = () => r!.one('#fix-on-failure .cioff button');
    // Fix on failure is off as the file has it: its header, what happens without it, and Show settings.
    expect(plain(r!.one('#fix-on-failure .cioff .offnote'))).toBe('Off: a failed check fails the build, and nobody opens a fix.');
    expect([show().textContent, show().getAttribute('aria-expanded'), show().getAttribute('aria-controls') === body().getAttribute('id'), body().hasAttribute('hidden')]).toEqual(['Show settings', 'false', true, true]);
    // The parts that are on have no such line: their panels are open.
    expect(r!.all('#pr-comment .cioff, #alerts .cioff')).toHaveLength(0);
    expect([r!.one('#pr-comment .cimain').hasAttribute('hidden'), r!.one('#alerts .alertgrid').hasAttribute('hidden')]).toEqual([false, false]);
    // Show settings opens the panel for a look, the part still off; Hide settings folds it again.
    await r!.click(show());
    expect([show().textContent, show().getAttribute('aria-expanded'), body().hasAttribute('hidden'), fix().className]).toEqual(['Hide settings', 'true', false, 'panel sec set cip off']);
    await r!.click(show());
    expect([show().textContent, body().hasAttribute('hidden')]).toEqual(['Show settings', true]);
    // Its switch opens it too, the line gone; off again, it folds.
    await r!.click(r!.one('#fix-on-failure header .switch'));
    await r!.until('Fix on failure on', () => fix().className === 'panel sec set cip');
    expect([r!.all('#fix-on-failure .cioff').length, body().hasAttribute('hidden')]).toEqual([0, false]);
    await r!.click(r!.one('#fix-on-failure header .switch'));
    await r!.until('Fix on failure off', () => fix().className === 'panel sec set cip off');
    expect(body().hasAttribute('hidden')).toBe(true);
    // Each list is behind its name and how many rows it holds, the rows drawn and hidden until asked for.
    const view = served({}, DEFAULTS_FILE);
    const folds = () => r!.all('.settab .cifold');
    const fold = (f: FakeElement) => [f.querySelector('button .k')!.textContent, f.querySelector('button .n')!.textContent, f.querySelector('button')!.getAttribute('aria-expanded'), f.querySelector('.cilist')!.hasAttribute('hidden')];
    expect(folds().map(fold)).toEqual([
      ['it needs', String(view.comment.needs.length), 'false', true],
      ['it needs', String(view.fixOnFailure.needs.length), 'false', true],
      ['it never', String(view.fixOnFailure.never.length), 'false', true],
      ['it needs', String(view.alerts.needs.length), 'false', true],
      ['a golden fails when', String(view.alerts.failures.length), 'false', true],
    ]);
    expect(folds().map((f) => f.querySelectorAll('.cilist li').length)).toEqual([view.comment.needs.length, view.fixOnFailure.needs.length, view.fixOnFailure.never.length, view.alerts.needs.length, view.alerts.failures.length]);
    // One opened leaves the others as they are, and its button names the list it opens.
    const fails = () => folds()[4];
    await r!.click(fails().querySelector('button')!);
    expect(folds().map((f) => f.querySelector('button')!.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false', 'false', 'true']);
    expect([fails().querySelector('.cilist')!.hasAttribute('hidden'), fails().querySelector('button')!.getAttribute('aria-controls') === fails().querySelector('.cilist')!.getAttribute('id')]).toEqual([false, true]);
    await r!.click(fails().querySelector('button')!);
    expect(fails().querySelector('.cilist')!.hasAttribute('hidden')).toBe(true);
  });

  it('writes a workflow that isn’t there yet after asking, with every line it adds, and its Undo takes the file away again', async () => {
    const s = fakeServer(null, { session: SESSION });
    const toast = vi.fn();
    await open(s, toast);
    expect(plain(r!.one('#workflow .wfstate'))).toBe('Not in your repository yet. Write it, then commit it.');
    expect(r!.all('#workflow p.muted').map((p) => plain(p))).toContain(sessionLine(SESSION));
    const view = served({}, null);
    await r!.click(r!.byText('#workflow header .btn', 'Write file'));
    expect(r!.one('[role="dialog"] header h3').textContent).toBe(`Write ${FILE}?`);
    expect(r!.all('[role="dialog"] header p span')[0].textContent).toBe('Adds the workflow the switches build to your repository.');
    expect(r!.one('[role="dialog"] .db').textContent.replace(/\u00a0/g, ' ')).toContain('your working tree');
    expect(r!.all('[role="dialog"] pre.wfcode span.add')).toHaveLength(view.workflow.added);
    await r!.click(r!.one('[role="dialog"] .dlg-ok'));
    await r!.until('the file written', () => plain(r!.one('#workflow .wfstate')).startsWith('The same'));
    expect(s.writeWorkflow).toHaveBeenCalledWith(expect.any(Object), 'absent', view.workflow.shown);
    expect(s.text).toBe(view.workflow.text);
    const wrote = toast.mock.calls.find((c) => c[0] === `Wrote ${FILE} · commit and push it to turn it on`);
    expect(wrote?.[1]).toBe('notice');
    expect(r!.all('#workflow header .btn')).toHaveLength(0);
    // Its Undo removes the file Write file made, against the version it wrote.
    (wrote![2] as { run: () => void }).run();
    await r!.until('the file taken away', () => plain(r!.one('#workflow .wfstate')).startsWith('Not in your repository yet'));
    expect(s.undoWorkflow).toHaveBeenCalledWith('w1');
    expect(s.text).toBeNull();
    expect(toast.mock.calls.map((c) => c[0])).toContain(`Removed ${FILE}, which Write file made`);
  });

  it('writes nothing over a file changed on disk since the page read it, says so in the page’s words, and shows the file as it is now', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    const toast = vi.fn();
    await open(s, toast);
    await r!.click(r!.one('#fix-on-failure header .switch'));
    await r!.until('Write file', () => r!.all('#workflow header .btn').length === 1);
    // Someone changes the file meanwhile.
    const theirs = `${DEFAULTS_FILE}# ours\n`;
    s.text = theirs;
    await r!.click(r!.byText('#workflow header .btn', 'Write file'));
    const asked = s.ciWorkflows.mock.calls.length;
    await r!.click(r!.one('[role="dialog"] .dlg-ok'));
    await r!.until('the refusal', () => toast.mock.calls.some((c) => c[1] === 'error'));
    expect(toast).toHaveBeenCalledWith(`${FILE} changed on disk since this page read it. It shows the file as it is now; nothing was changed.`, 'error');
    expect(s.text).toBe(theirs);
    // Read again: their line in the file it shows, Fix on failure still as it was changed here.
    await r!.until('the file as it is now', () => s.ciWorkflows.mock.calls.length > asked && shownFile().includes('# ours'));
    expect(r!.one('#fix-on-failure header .switch').getAttribute('aria-checked')).toBe('true');
    await r!.click(r!.one('#fix-on-failure header .switch'));
    await r!.until('Fix on failure off again', () => r!.one('#fix-on-failure header .switch').getAttribute('aria-checked') === 'false');
  });

  it('words the last test session as it was seen, and CI’s own as Last seen in CI', () => {
    const now = Date.UTC(2026, 10, 8, 10, 2);
    expect(sessionLine({ ci: false, revision: 'd2e8a1f0c4b7', at: now - 20_000, text: '2 of 7 goldens passed' }, now)).toBe('The last test session, d2e8a1f, just now: 2 of 7 goldens passed.');
    // No revision says so, as Tests' session line does.
    expect(sessionLine({ ci: true, revision: null, at: now - 5_000, text: '7 of 7 goldens passed' }, now)).toBe('Last seen in CI, no revision, just now: 7 of 7 goldens passed.');
    expect(sessionLine({ ci: false, revision: null, at: now - 3_600_000, text: 'x' }, now)).toMatch(/^The last test session, no revision at .+: x\.$/);
    expect(sessionLine({ ci: false, revision: 'release-1', at: now - 3_600_000, text: 'x' }, now)).toMatch(/^The last test session, release-1 at .+: x\.$/);
  });

  it('lists under Alerts what fails a golden, the injection gate too, and an inconclusive one in amber, with the keys the goldens that run live need', async () => {
    await open(fakeServer(DEFAULTS_FILE));
    const fails = r!.all('#alerts .teamside .cilist li');
    expect(fails.map((li) => li.querySelector('code')?.textContent)).toEqual(['diverged', 'live call', 'exit ≠ 0', 'check failed', 'injection', 'inconclusive']);
    expect(fails.map((li) => li.querySelector('i')?.getAttribute('class'))).toEqual(['err', 'err', 'err', 'err', 'err', 'warn']);
    // The inconclusive row gives the same exception Gates' row does: a young gate against history only warns.
    expect(fails.at(-1)!.querySelector('span')!.textContent).toBe('a gate, a judge or an injection test can’t decide, but a gate against a history of fewer than 30 sessions only warns while the plan reads no decline or drop in them');
    // The two fork goldens' key, in Alerts' needs and in the test step's env; the pull request comment needs its own.
    expect(r!.all('#alerts .cimain .cilist li').map((li) => li.textContent)).toContain('2 goldens run live (fork)ANTHROPIC_API_KEY');
    expect(r!.all('#pr-comment .cimain .cilist li')).toHaveLength(1);
    expect(shownFile()).toMatch(/^ +env:\n +ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}$/m);
  });

  it('sets what an inconclusive golden does in Your workflow, in the design’s words, which takes the row from Alerts and adds the input to the step', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    const toast = vi.fn();
    await open(s, toast);
    const row = () => r!.all('#workflow .setrow').find((x) => x.querySelector('b')?.textContent === 'An inconclusive golden')!;
    // Fails writes no input, as shadowlap test does by default: a gate against a short history only warns, and the row says so.
    expect(plain(row().querySelector('span')!)).toBe('Fails the step, as a failed one does, but a gate against a history of fewer than 30 sessions only warns while the plan reads no decline or drop in them. Run more attempts can settle it.');
    expect(RECORD_WINDOWS * BASELINE_DEFAULTS.window).toBe(30);
    expect(shownFile()).not.toContain('inconclusive:');
    const seg = r!.one('#workflow .seg[aria-labelledby="inconclusive-name"]');
    expect(seg.querySelectorAll('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Fails', 'true'],
      ['Warns', 'false'],
    ]);
    await r!.click(r!.byText('#workflow .seg[aria-labelledby="inconclusive-name"] button', 'Warns'));
    await r!.until('the answer for warn', () => r!.all('#alerts .teamside .cilist li').length === 5);
    expect(s.ciWorkflows).toHaveBeenLastCalledWith(expect.objectContaining({ inconclusive: 'warn' }));
    expect(toast).toHaveBeenCalledWith('An inconclusive golden warns · Your workflow says inconclusive: warn');
    expect(shownFile()).toMatch(/^ +inconclusive: warn$/m);
    expect(plain(row().querySelector('span')!)).toBe('Lets the step pass with a warning: inconclusive: warn. Every report still says inconclusive.');
    expect(row().querySelector('span code')!.textContent).toBe('inconclusive: warn');
    // Back to Fails: the input goes, and the toast says what the default does with a short history.
    await r!.click(r!.byText('#workflow .seg[aria-labelledby="inconclusive-name"] button', 'Fails'));
    await r!.until('the answer for fail', () => r!.all('#alerts .teamside .cilist li').length === 6);
    expect(s.ciWorkflows).toHaveBeenLastCalledWith(expect.objectContaining({ inconclusive: 'fail' }));
    expect(toast).toHaveBeenLastCalledWith('An inconclusive golden fails the step, the default · a gate against fewer than 30 sessions only warns');
    expect(shownFile()).not.toContain('inconclusive:');
  });

  it('keeps each key of a long list whole, breaking only after a comma', async () => {
    const many = [{ path: 'goldens/a', live: [], keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], known: true }];
    await open(fakeServer(DEFAULTS_FILE, { goldens: many }));
    // Every golden's keys are what a fix pull request needs: blame and verify run the agent live.
    await r!.click(r!.one('#fix-on-failure header .switch'));
    const row = () => r!.all('#fix-on-failure .cimain .cilist li').find((li) => li.textContent.startsWith('your agent’s provider keys'));
    await r!.until('the keys a fix needs', () => !!row() && r!.one('#fix-on-failure').className === 'panel sec set cip');
    const code = row()!.querySelector('code')!;
    expect(code.textContent).toBe('ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY');
    expect(code.querySelectorAll('span.nw').map((x) => x.textContent)).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    await r!.click(r!.one('#fix-on-failure header .switch'));
    await r!.until('no fix again', () => r!.one('#fix-on-failure').className === 'panel sec set cip off');
  });

  it('says the config can’t be read, as the other tabs do, what the workflow leaves out, and why Write file waits', async () => {
    const configError = 'shadowlap.config.json: not valid JSON (Unexpected end of JSON input)';
    await open(fakeServer(DEFAULTS_FILE, { goldens: [], configError }));
    expect(plain(r!.one('.settab .verdict h2'))).toBe('can’t read Fix shadowlap.config.json to change these settings');
    expect(r!.one('.settab .verdict p').textContent).toContain('not valid JSON');
    const unread = r!.all('.settab .cilist li').find((li) => li.textContent.startsWith('which goldens run live'))!;
    expect(unread.querySelector('i')!.getAttribute('class')).toBe('warn');
    expect(shownFile()).toContain("#   shadowlap.config.json can't be read: the keys of the goldens that run live are left out");
    expect(plain(r!.one('#workflow .cistore span'))).toBe('shadowlap.config.json can’t be read, so whether fixes go to a team store isn’t known until it is fixed.');
    const problem = served({}, DEFAULTS_FILE, { goldens: [], configError }).problem;
    expect(problem).toBeTruthy();
    expect(r!.one('#workflow .fieldnote').textContent).toBe(problem);
  });
});

describe('Settings → CI: the pull request comment', () => {
  const comment = () => r!.one('#pr-comment');
  const preview = () => r!.byText('#pr-comment .actions button', 'Preview pull request comment');
  const needs = () => r!.all('#pr-comment .cimain .cilist li').map((li) => [li.querySelector('span')?.textContent ?? '', li.querySelector('code')?.textContent ?? '']);

  it('says what the comment carries, and previews it from the last test session: the session, who posts it, the comment, and Copy Markdown', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    s.preview = PREVIEW;
    const toast = vi.fn();
    const writes: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: (t: string) => (writes.push(t), Promise.resolve()) } });
    await open(s, toast);
    expect(plain(comment().querySelector('.cimain > p.muted')!)).toBe('One comment on each pull request, kept current on every push: each golden’s verdict by its gate, beside the base branch’s last session, a run’s cost before and after, and what planted instructions did.');
    // Its card says which session it reads, once read.
    await r!.until('the preview read', () => preview().getAttribute('data-tip') === tipCard('Preview pull request comment', [], previewSub(PREVIEW.session)));
    expect(previewSub(PREVIEW.session)).toMatch(/^From the last test session, d2e8a1f\+dirty at /);
    expect(preview().getAttribute('aria-disabled')).toBeNull();
    await r!.click(preview());
    await r!.until('the dialog', () => r!.all('[role="dialog"] .prc').length === 1);
    const dialog = r!.one('[role="dialog"]');
    expect(dialog.className).toBe('dialog prdlg');
    expect(plain(dialog.querySelector('header h3')!)).toBe('Preview pull request comment');
    expect(plain(dialog.querySelector('header p > span:not([hidden])')!)).toBe('The one comment the Action keeps on each pull request, edited on every push. Pull request comments in the docs →');
    expect(dialog.querySelectorAll('.dfacts > div').map((row) => [row.querySelector('dt')!.textContent, plain(row.querySelector('dd')!), row.querySelector('dd small') ? plain(row.querySelector('dd small')!) : null])).toEqual([
      ['Session', `${previewSub(PREVIEW.session).replace('From the last test session, ', '')}the last test session`, 'the last test session'],
      ['Posted by', 'github-actions', null],
    ]);
    // The comment as GitHub shows it: the heading's tally, each golden worst first with its mark, the decisions, the cost, the injection gate and the job summary's line.
    const prc = dialog.querySelector('.prc')!;
    // Its tally glued as the mock's is, a count with its noun.
    expect(plain(prc.querySelector('h4')!)).toBe('Shadowlap: 1 of 2 goldens passed · 1 failed');
    expect(prc.querySelector('h4')!.textContent).toContain('2\u00a0goldens');
    expect(prc.querySelectorAll('.prc-g li').map((li) => [li.getAttribute('class'), li.querySelector('i')!.textContent, li.querySelector('code')!.textContent, plain(li.querySelector('span')!)])).toEqual([
      ['fail', '✗', 'goldens/refund-over-limit', 'failed · diverged at call 3 · $.messages[2].content'],
      ['pass', '✓', 'goldens/refund-flow-budget', 'passed · replayed clean'],
    ]);
    expect(prc.querySelectorAll('h5').map((h) => h.textContent)).toEqual(['Decisions', 'Injection']);
    expect(plain(prc.querySelector('.prc-dh')!)).toBe('✗ 1 of 2 goldens decides a write or when to stop differently, under the prompt and tools this pull request sends');
    expect(prc.querySelectorAll('.prc-d').map((d) => [d.querySelector('.prc-rk')!.getAttribute('class'), plain(d.querySelector('p')!)])).toEqual([
      ['prc-rk', 'rank 1 goldens/refund-over-limit #11 · add_note is no longer called; issue_refund is called'],
      ['prc-rk r2', 'rank 2 goldens/refund-over-limit #12 · ends the run'],
    ]);
    // A call cut on one line, whole on hover, a phone breaking after a comma but never in an order's id.
    const call = prc.querySelectorAll('.prc-a .prc-call')[1];
    expect([call.textContent, call.getAttribute('title'), call.querySelectorAll('wbr').length, call.querySelectorAll('span.nw').map((x) => x.textContent)]).toEqual(['issue_refund({"order":"ord-1042","amount":240})', 'issue_refund({"order":"ord-1042","amount":240})', 1, ['"ord-1042"']]);
    expect(prc.querySelector('.prc-dim')!.textContent).toBe(PREVIEW.decisions!.note);
    expect(plain(prc.querySelector('.prc-cost')!)).toBe('cost per run ≈$0.041 → ≈$0.043 (+5%)');
    expect(prc.querySelectorAll('.prc-i').map((x) => [x.getAttribute('class'), x.querySelector('i')!.textContent, x.querySelector('code')!.textContent, plain(x.querySelector('span')!)])).toEqual([['prc-i pass', '✓', 'goldens/refund-flow-budget', PREVIEW.injection[0].line]]);
    // An injection gate's line breaks only after a dot, each part kept whole, as the design's dotJoin keeps one.
    expect(prc.querySelector('.prc-i > span')!.querySelectorAll('span.nw').map((x) => plain(x))).toEqual(['passed ·', '6 attempts ·', '0 obeyed (at most 0 allowed) ·', '0 influenced ·', '6 ignored']);
    // The job summary's line in the server's words, the Action's without the job's address the preview can't know.
    const foot = commentMarkdown({ results: [], runUrl: 'u' }).trimEnd().split('\n').at(-1)!;
    expect(foot).toBe("[The job's summary](u) has each failure in full.");
    expect(foot.replace(/\[(.+?)\]\(u\)/, '$1')).toBe(COMMENT_FOOT);
    expect(prc.querySelector('.prc-foot')!.textContent).toBe(PREVIEW.foot);
    // Close first, then Copy Markdown, which copies what the Action would post and stays open.
    expect(dialog.querySelectorAll('footer button').filter((b) => !b.hasAttribute('hidden')).map((b) => b.textContent)).toEqual(['Close', 'Copy Markdown']);
    expect(r!.focused().textContent).toBe('Close');
    await r!.click(r!.byText('[role="dialog"] footer button', 'Copy Markdown'));
    await r!.until('the copy', () => writes.length === 1);
    expect(writes).toEqual([PREVIEW.markdown]);
    await r!.until('its toast', () => toast.mock.calls.some((c) => c[0] === 'Copied the comment’s Markdown'));
    expect(r!.all('[role="dialog"]')).toHaveLength(1);
    await r!.click(r!.byText('[role="dialog"] footer button', 'Close'));
    expect(r!.all('[role="dialog"]')).toHaveLength(0);
  });

  it('waits before a session ran every golden, saying why on its card and in the toast a press raises; the palette’s ask opens the preview', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    const toast = vi.fn();
    await open(s, toast);
    await r!.until('the preview read', () => preview().getAttribute('aria-disabled') === 'true');
    expect(preview().getAttribute('data-tip')).toBe(tipCard('Preview pull request comment', [], 'The comment is the last test session’s: run the tests once'));
    await r!.click(preview());
    expect(toast).toHaveBeenCalledWith('No test session yet: run the tests once', 'notice', undefined);
    expect(r!.all('[role="dialog"]')).toHaveLength(0);
    await r!.unmount();
    // Asked for from the palette before the page showed (on another page's window): it opens as the panel does.
    s.preview = PREVIEW;
    vi.stubGlobal('window', { dispatchEvent: () => true });
    PR_COMMENT_ASK.ask();
    await open(s, toast);
    await r!.until('the dialog', () => r!.all('[role="dialog"] .prc').length === 1);
    expect(PR_COMMENT_ASK.take()).toBe(false);
  });

  it('says a preview it couldn’t read as every page does, never a bare status, and Retry reads it again', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    s.prComment.mockImplementation(async () => {
      throw new ApiError(500, 'HTTP 500');
    });
    await open(s);
    await r!.until('the panel’s read', () => s.prComment.mock.calls.length === 1);
    // The panel's read failed, so the dialog reads it itself, and says it couldn't, with Retry.
    await r!.click(preview());
    await r!.until('the failure', () => r!.all('[role="dialog"] .loaderr').length === 1);
    const failed = r!.one('[role="dialog"] .loaderr');
    expect([failed.getAttribute('role'), ...failed.querySelectorAll('p > span').map((x) => x.textContent)]).toEqual(['alert', 'couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    expect(r!.byText('[role="dialog"] footer button', 'Copy Markdown').hasAttribute('disabled')).toBe(true);
    s.prComment.mockImplementation(async () => PREVIEW);
    await r!.click(r!.byText('[role="dialog"] .loaderr button', 'Retry'));
    await r!.until('the comment', () => r!.all('[role="dialog"] .prc').length === 1);
    expect(r!.all('[role="dialog"] .loaderr')).toHaveLength(0);
  });

  it('switches the decisions the branch changes into the comment, with the model key in what posting needs, only while the comment is on', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    const toast = vi.fn();
    await open(s, toast);
    const row = () => r!.all('#pr-comment .setrow').find((x) => x.querySelector('b')?.textContent === 'The decisions the branch changes')!;
    expect(plain(row().querySelector('span')!)).toBe('Asks the goldens’ models on every push, so the step needs their keys.');
    const decisions = () => r!.one('#pr-comment .setrow .switch[aria-labelledby="cidecisions-name"]');
    expect([decisions().getAttribute('aria-checked'), decisions().getAttribute('aria-describedby')]).toEqual(['false', 'cidecisions-help']);
    expect(needs()).toEqual([['permission to keep the action’s comment on a pull request', 'pull-requests: write']]);
    await r!.click(decisions());
    await r!.until('the answer with decisions', () => needs().length === 2);
    expect(s.ciWorkflows).toHaveBeenLastCalledWith(expect.objectContaining({ decisions: true }));
    expect(toast).toHaveBeenCalledWith('The decisions are on · Your workflow changes with it');
    expect(needs()[1]).toEqual(['a model key, for the decisions the branch changes', 'ANTHROPIC_API_KEY']);
    expect(plain(comment().querySelector('.cimain > p.muted')!)).toContain('beside the base branch’s last session, the decisions the branch changes, a run’s cost before and after');
    expect(shownFile()).toMatch(/^ +decisions: true$/m);
    // The comment off: nothing of the decisions is written, and posting needs nothing.
    await r!.click(r!.one('#pr-comment header .switch'));
    await r!.until('the comment off', () => comment().className === 'panel sec set cip prpanel off');
    expect(needs().map(([what]) => what)).not.toContain('a model key, for the decisions the branch changes');
    expect(shownFile()).not.toContain('decisions: true');
  });
});

describe('Settings → Gates', () => {
  it('previews a gate as its figures change, asking only for those that differ from the defaults, with Reset and the golden’s entry', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    await openGates(s);
    // The tab's one section, none of the CI tab's panels beside it.
    expect(r!.all('.settab section.sec').map((x) => x.getAttribute('id'))).toEqual(['gates']);
    expect(r!.one('nav.stabs a[aria-current="page"]').textContent).toBe('Gates');
    expect(r!.one('#gates header .sub').textContent.replace(/\u00a0/g, ' ')).toBe('try figures, then copy the golden’s entry');
    expect(s.gate).toHaveBeenLastCalledWith('suiteRisk=0.05', expect.anything());
    expect(r!.all('#gates select').map((x) => x.getAttribute('aria-label'))).toEqual(['Good', 'Bad', 'Risk', 'Max']);
    expect(plain(r!.one('#gates .gdef'))).toBe('The defaults: what "gate": {} stands for, as refund-flow-budget uses it.');
    expect(plain(r!.one('#gates .gsays'))).toBe(gatePreview(new URLSearchParams('suiteRisk=0.05')).sentence);
    expect(r!.one('#gates .cicode .codebox').textContent).toContain('"gate": {}');
    // A figure changed: asked again with it alone, the note says what the defaults stand for, and the entry names it.
    await r!.type(r!.one('#gates select[aria-label="Max"]'), '20');
    await r!.until('the preview for max 20', () => r!.one('#gates .cicode .codebox').textContent.includes('"gate": { "max": 20 }'));
    expect(s.gate).toHaveBeenLastCalledWith('max=20&suiteRisk=0.05', expect.anything());
    expect(plain(r!.one('#gates .gdef'))).toMatch(/^These differ from the defaults: "gate": \{\} stands for .+\. Reset$/);
    // A pair the config refuses: its words, and nothing to copy.
    await r!.type(r!.one('#gates select[aria-label="Bad"]'), '0.9');
    await r!.until('the refusal', () => r!.all('#gates .gprev .fieldnote.err').length === 1);
    expect(r!.one('#gates .gprev .k').textContent).toBe('the config refuses it');
    expect(r!.all('#gates .cicode')).toHaveLength(0);
    // Reset: the defaults again, asked for with no figure.
    await r!.click(r!.byText('#gates .gdef button', 'Reset'));
    await r!.until('the defaults again', () => r!.all('#gates .cicode .codebox').length === 1 && r!.one('#gates .cicode .codebox').textContent.includes('"gate": {}'));
    expect(s.gate).toHaveBeenLastCalledWith('suiteRisk=0.05', expect.anything());
    expect(plain(r!.one('#gates .gdef'))).toMatch(/^The defaults:/);
  });

  it('opens on the kind a link asks for, history’s figures with it, and puts the address back to the tab’s own', async () => {
    address = '#/settings/gates?gate=baseline';
    const s = fakeServer(DEFAULTS_FILE);
    await openGates(s);
    await r!.until('the history preview', () => r!.all('#gates select[aria-label="Window"]').length === 1 && s.gate.mock.calls.some((c) => c[0] === 'baseline=history&suiteRisk=0.05'));
    expect(address).toBe('#/settings/gates');
    expect(r!.all('#gates select').map((x) => x.getAttribute('aria-label'))).toEqual(['Drop', 'Risk', 'Window', 'Min', 'Max']);
    expect(r!.byText('#gates header .seg button', 'fork · history').getAttribute('aria-pressed')).toBe('true');
    const history = gatePreview(new URLSearchParams('baseline=history&suiteRisk=0.05'));
    await r!.until('its sentence', () => plain(r!.one('#gates .gsays')) === history.sentence);
    expect(r!.one('#gates .cicode .codebox').textContent).toContain('"gate": { "baseline": "history" }');
    // Back to fork · gate by its switch, which asks for the SPRT gate's defaults.
    await r!.click(r!.byText('#gates header .seg button', 'fork · gate'));
    await r!.until('the gate preview', () => r!.all('#gates select[aria-label="Good"]').length === 1);
    expect(s.gate).toHaveBeenLastCalledWith('suiteRisk=0.05', expect.anything());
  });

  it('says what an inconclusive golden does in CI as Your workflow has it, changed there and not written yet too, and leads to where it is set', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    const line = () => r!.all('#gates .setrow').find((x) => x.querySelector('b')?.textContent === 'An inconclusive golden')!;
    await openGates(s);
    // No control of its own: the words, and the way to the CI tab, where Your workflow sets it.
    expect(plain(line().querySelector('span')!)).toMatch(/^Fails the step, as a failed one does/);
    expect(r!.all('#gates .seg').map((x) => x.getAttribute('aria-label'))).toEqual(['Kind of gate']);
    expect([line().querySelector('a')!.textContent, line().querySelector('a')!.getAttribute('href')]).toEqual(['Settings → CI', '#/settings/ci']);
    // In CI heads it on a line of its own, as a part's heading does: its first letter is raised only there.
    expect(r!.all('#gates .cimain > .k').map((k) => [k.textContent, k.className])).toEqual([['in CI', 'k gci']]);
    expect(styleRules().filter((x) => !x.conditions.length && x.selectors.includes('.gatep .gci')).flatMap((x) => x.decls)).toContainEqual(['display', 'block']);
    await r!.unmount();
    // Warns, picked on the CI tab and not written: Gates reads it, and words its CI figure for a step that warns.
    await open(s);
    await r!.click(r!.byText('#workflow .seg[aria-labelledby="inconclusive-name"] button', 'Warns'));
    await r!.until('the answer for warn', () => /^ +inconclusive: warn$/m.test(shownFile()));
    await r!.unmount();
    try {
      await openGates(s);
      expect(s.ciWorkflows).toHaveBeenLastCalledWith(expect.objectContaining({ inconclusive: 'warn' }));
      expect(plain(line().querySelector('span')!)).toBe('Lets the step pass with a warning: inconclusive: warn. Every report still says inconclusive.');
    } finally {
      delete keptFor('support-agent').inconclusive;
    }
  });

  it('is where a link to a gate’s kind from when Gates was CI’s last panel goes on to, its kind kept', async () => {
    address = '#/settings/ci?gate=baseline';
    await open(fakeServer(DEFAULTS_FILE));
    await r!.until('the address of Gates', () => address === '#/settings/gates?gate=baseline');
    // The CI tab alone stays where it is.
    await r!.unmount();
    address = '#/settings/ci';
    await open(fakeServer(DEFAULTS_FILE));
    expect(address).toBe('#/settings/ci');
  });

  it('words its note from the answer’s CI figures, and names the attempts column in a hover card', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    // A CI run as the answer figures it: 40 goldens of an agent that passes 85% of the time, short of the gate's good rate.
    s.gate.mockImplementation(async (query: string) => {
      const p = gatePreview(new URLSearchParams(query));
      return { ...p, ci: { ...p.ci, goldens: 40, rate: 0.85, redText: '1.5%', redWarnText: '1.5%' } };
    });
    await openGates(s);
    expect(plain(r!.one('#gates .gnote'))).toBe('Between 70% and 90% either verdict can come, so a verdict states the test, never the agent’s rate. With 40 forked goldens of an agent that passes 85% of the time, 1.5% of CI runs go red.');
    const attempts = r!.byText('#gates table.godds th', 'attempts');
    expect([attempts.getAttribute('data-tip'), attempts.getAttribute('title')]).toEqual([tipCard('attempts', [], 'the attempts it runs on average'), null]);
  });

  it('waits while the dashboard server is away, saying the preview is the last it worked out', async () => {
    await openGates(fakeServer(DEFAULTS_FILE), 'offline');
    expect(plain(r!.one('#gates .gdef'))).toBe('Paused until the dashboard server is back: the preview is the last it worked out.');
    expect(r!.all('#gates select').every((x) => x.props.disabled === true)).toBe(true);
  });
});

/** The tab in a dashboard over projects, each with its own repository: `moveTo` switches as the project switcher does. */
async function openProjects(servers: Record<string, ReturnType<typeof fakeServer>>, first: string): Promise<(to: string) => Promise<void>> {
  let move: (to: string) => void = () => undefined;
  function Projects() {
    const [shown, setShown] = useState(first);
    move = setShown;
    const value = useMemo(() => ({ ...app(servers[shown]), meta: { project: { id: shown, name: shown, path: `/work/${shown}` } } }) as AppState, [shown]);
    return createElement(AppContext.Provider, { value }, createElement(SettingsPage, { tab: 'ci' }));
  }
  r = await render(createElement(Projects));
  await r.until('the panels', () => r!.all('#alerts .cilist').length > 1);
  return (to) => act(async () => move(to));
}

describe('Settings → CI over projects', () => {
  it('keeps a switch changed in one project to it: another starts from its own workflow, and the first keeps the change', async () => {
    // south-agent's workflow has no pull request comment.
    const servers = { 'north-agent': fakeServer(DEFAULTS_FILE), 'south-agent': fakeServer(served({ comment: false }, null).workflow.text) };
    const moveTo = await openProjects(servers, 'north-agent');
    const on = (id: string) => r!.one(`#${id} header .switch`).getAttribute('aria-checked');
    // Fix on failure on in north-agent, not written.
    await r!.click(r!.one('#fix-on-failure header .switch'));
    await r!.until('north-agent’s change', () => on('fix-on-failure') === 'true' && r!.all('#workflow header .btn').length === 1);
    // south-agent's switches are its own file's, asked for with nothing changed: nothing to write.
    await moveTo('south-agent');
    await r!.until('south-agent’s workflow', () => r!.all('#workflow .wfstate').length === 1);
    expect(servers['south-agent'].ciWorkflows.mock.calls.map(([o]) => o)).toEqual([{}]);
    expect([on('pr-comment'), on('fix-on-failure')]).toEqual(['false', 'false']);
    expect(plain(r!.one('#workflow .wfstate'))).toBe(`The same as your repository’s ${FILE}.`);
    expect(r!.all('#workflow header .btn')).toHaveLength(0);
    // Back in north-agent, its change is there still, to write or to turn back.
    await moveTo('north-agent');
    await r!.until('north-agent’s change again', () => r!.all('#workflow .wfstate').length === 1 && on('fix-on-failure') === 'true');
    expect([on('pr-comment'), r!.all('#workflow header .btn').length]).toEqual(['true', 1]);
    await r!.click(r!.one('#fix-on-failure header .switch'));
    await r!.until('north-agent’s file again', () => on('fix-on-failure') === 'false' && r!.all('#workflow header .btn').length === 0);
  });
});
