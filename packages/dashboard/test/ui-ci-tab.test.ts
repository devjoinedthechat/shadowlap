import { act, createElement, useMemo, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASELINE_DEFAULTS, readWorkflow, RECORD_WINDOWS, workflowVersion } from '@shadowlap/engine';
import { fileSwitches, type RepositoryWorkflow } from '../src/ci-file.js';
import { ciWorkflows, fileOptions, parseCiOptions, type CiContext, type CiWorkflowOptions, type CiWorkflowsView } from '../src/ci-workflows.js';
import { gatePreview } from '../src/tests-gate.js';
import { ApiError } from '../ui/api.js';
import { tipCard } from '../ui/components/HoverCard.js';
import { sessionLine } from '../ui/pages/settings/CiWorkflow.js';
import { SettingsPage } from '../ui/pages/Settings.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Settings → CI as the page renders the server's answers: Your workflow first, where the
 * repository's file stands against the one the switches build, folded behind Show workflow, with
 * Write file and its ask while the two differ; then Pull request comment, Fix on failure and Alerts,
 * each with its switch in its header and its own needs; then Gates, which previews a gate's figures
 * and holds what an inconclusive golden does in CI. The fake server answers as the routes do: the
 * switches start from the repository's file, Write file writes it, and its Undo puts it back.
 */

const goldens = [
  { path: 'goldens/refund-flow-budget', live: ['fork' as const], keys: ['ANTHROPIC_API_KEY'], known: true },
  { path: 'goldens/refund-over-limit', live: ['fork' as const], keys: ['ANTHROPIC_API_KEY'], known: true },
];
const FILE = '.github/workflows/agent.yml';
const GATES: NonNullable<CiContext['gates']> = { suiteRisk: 0.05, uses: { sprt: ['refund-flow-budget'], baseline: [] } };
const SESSION = { ci: false, revision: 'd2e8a1f0c4', at: Date.now() - 3_600_000, text: '2 of 7 goldens passed · 3 failed, 2 inconclusive' };

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
  const client = { ciWorkflows: s.ciWorkflows, settings: { writeWorkflow: s.writeWorkflow, undoWorkflow: s.undoWorkflow, gate: s.gate }, teamStore: async () => null, jobs: async () => [], storeSetup: { view: async () => null } };
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
  r = await render(createElement(AppContext.Provider, { value: app(s, toast, conn) }, createElement(SettingsPage, { tab })));
  await r.until('the panels and the gate preview', () => r!.all('#alerts .cilist').length > 1 && r!.all('#gates .gsays').length === 1);
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
  it('lays the tab out as the design does: Your workflow, a panel for each part with its switch in its header, then Gates', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    const toast = vi.fn();
    // Alerts' old address opens the tab too.
    await open(s, toast, 'ok', 'alerts');
    expect(r!.all('.settab section.sec').map((x) => x.getAttribute('id'))).toEqual(['workflow', 'pr-comment', 'fix-on-failure', 'alerts', 'gates']);
    for (const [id, label] of [
      ['pr-comment', 'Pull request comment'],
      ['fix-on-failure', 'Fix on failure'],
      ['alerts', 'Alerts'],
    ]) {
      expect(r!.all(`#${id} header .switch[aria-label="${label}"]`)).toHaveLength(1);
    }
    expect(r!.one('#workflow header .sub').textContent.replace(/\u00a0/g, ' ')).toBe('built from the switches below');
    // The repository's file is the one the switches build: nothing to write.
    expect(r!.one('#workflow .wfstate').textContent).toBe(`The same as your repository’s ${FILE}.`);
    expect(r!.all('#workflow header .btn')).toHaveLength(0);
    // The file folds behind Show workflow, with Copy workflow beside it.
    const show = r!.one('#workflow .wftog button[aria-controls="wfBox"]');
    expect([show.textContent, show.getAttribute('aria-expanded'), r!.one('#wfBox').hasAttribute('hidden')]).toEqual(['Show workflow', 'false', true]);
    expect(r!.byText('#workflow .wftog button', 'Copy workflow')).toBeTruthy();
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
    expect(r!.one('#workflow .wfstate').textContent).toBe(`The same as your repository’s ${FILE}.`);
    expect(r!.all('#wfBox pre.wfcode span.add')).toHaveLength(0);
  });

  it('writes a workflow that isn’t there yet after asking, with every line it adds, and its Undo takes the file away again', async () => {
    const s = fakeServer(null, { session: SESSION });
    const toast = vi.fn();
    await open(s, toast);
    expect(plain(r!.one('#workflow .wfstate'))).toBe('Not in your repository yet. Write it, then commit it.');
    expect(r!.all('#workflow p.muted').map((p) => p.textContent)).toContain(sessionLine(SESSION));
    const view = served({}, null);
    await r!.click(r!.byText('#workflow header .btn', 'Write file'));
    expect(r!.one('[role="dialog"] header h3').textContent).toBe(`Write ${FILE}?`);
    expect(r!.all('[role="dialog"] header p span')[0].textContent).toBe('Adds the workflow the switches build to your repository.');
    expect(r!.one('[role="dialog"] .db').textContent).toContain('your working tree');
    expect(r!.all('[role="dialog"] pre.wfcode span.add')).toHaveLength(view.workflow.added);
    await r!.click(r!.one('[role="dialog"] .dlg-ok'));
    await r!.until('the file written', () => r!.one('#workflow .wfstate').textContent.startsWith('The same'));
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

  it('sets what an inconclusive golden does under Gates, in the design’s words, which takes the row from Alerts and adds the input to the step', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    const toast = vi.fn();
    await open(s, toast);
    const row = () => r!.all('#gates .setrow').find((x) => x.querySelector('b')?.textContent === 'An inconclusive golden')!;
    // Fails writes no input, as shadowlap test does by default: a gate against a short history only warns, and the row says so.
    expect(row().querySelector('span')!.textContent).toBe('Fails the step, as a failed one does, but a gate against a history of fewer than 30 sessions only warns while the plan reads no decline or drop in them. Run more attempts can settle it.');
    expect(RECORD_WINDOWS * BASELINE_DEFAULTS.window).toBe(30);
    expect(shownFile()).not.toContain('inconclusive:');
    const seg = r!.one('#gates .seg[aria-labelledby="inconclusive-name"]');
    expect(seg.querySelectorAll('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Fails', 'true'],
      ['Warns', 'false'],
    ]);
    await r!.click(r!.byText('#gates .seg[aria-labelledby="inconclusive-name"] button', 'Warns'));
    await r!.until('the answer for warn', () => r!.all('#alerts .teamside .cilist li').length === 5);
    expect(s.ciWorkflows).toHaveBeenLastCalledWith(expect.objectContaining({ inconclusive: 'warn' }));
    expect(toast).toHaveBeenCalledWith('An inconclusive golden warns · Your workflow says inconclusive: warn');
    expect(shownFile()).toMatch(/^ +inconclusive: warn$/m);
    expect(row().querySelector('span')!.textContent).toBe('Lets the step pass with a warning: inconclusive: warn. Every report still says inconclusive.');
    expect(row().querySelector('span code')!.textContent).toBe('inconclusive: warn');
    // Back to Fails: the input goes, and the toast says what the default does with a short history.
    await r!.click(r!.byText('#gates .seg[aria-labelledby="inconclusive-name"] button', 'Fails'));
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
    expect(r!.one('#workflow .cistore span').textContent).toBe('shadowlap.config.json can’t be read, so whether fixes go to a team store isn’t known until it is fixed.');
    const problem = served({}, DEFAULTS_FILE, { goldens: [], configError }).problem;
    expect(problem).toBeTruthy();
    expect(r!.one('#workflow .fieldnote').textContent).toBe(problem);
  });
});

describe('Settings → CI: Gates', () => {
  it('previews a gate as its figures change, asking only for those that differ from the defaults, with Reset and the golden’s entry', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    await open(s);
    expect(r!.one('#gates header .sub').textContent.replace(/\u00a0/g, ' ')).toBe('try figures, then copy the golden’s entry');
    expect(s.gate).toHaveBeenLastCalledWith('suiteRisk=0.05', expect.anything());
    expect(r!.all('#gates select').map((x) => x.getAttribute('aria-label'))).toEqual(['Good', 'Bad', 'Risk', 'Max']);
    expect(plain(r!.one('#gates .gdef'))).toBe('The defaults: what "gate": {} stands for, as refund-flow-budget uses it.');
    expect(r!.one('#gates .gsays').textContent).toBe(gatePreview(new URLSearchParams('suiteRisk=0.05')).sentence);
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
    address = '#/settings/ci?gate=baseline';
    const s = fakeServer(DEFAULTS_FILE);
    await open(s);
    await r!.until('the history preview', () => r!.all('#gates select[aria-label="Window"]').length === 1 && s.gate.mock.calls.some((c) => c[0] === 'baseline=history&suiteRisk=0.05'));
    expect(address).toBe('#/settings/ci');
    expect(r!.all('#gates select').map((x) => x.getAttribute('aria-label'))).toEqual(['Drop', 'Risk', 'Window', 'Min', 'Max']);
    expect(r!.byText('#gates header .seg button', 'fork · history').getAttribute('aria-pressed')).toBe('true');
    const history = gatePreview(new URLSearchParams('baseline=history&suiteRisk=0.05'));
    await r!.until('its sentence', () => r!.one('#gates .gsays').textContent === history.sentence);
    expect(r!.one('#gates .cicode .codebox').textContent).toContain('"gate": { "baseline": "history" }');
    // Back to fork · gate by its switch, which asks for the SPRT gate's defaults.
    await r!.click(r!.byText('#gates header .seg button', 'fork · gate'));
    await r!.until('the gate preview', () => r!.all('#gates select[aria-label="Good"]').length === 1);
    expect(s.gate).toHaveBeenLastCalledWith('suiteRisk=0.05', expect.anything());
  });

  it('words its note from the answer’s CI figures, and names the attempts column in a hover card', async () => {
    const s = fakeServer(DEFAULTS_FILE);
    // A CI run as the answer figures it: 40 goldens of an agent that passes 85% of the time, short of the gate's good rate.
    s.gate.mockImplementation(async (query: string) => {
      const p = gatePreview(new URLSearchParams(query));
      return { ...p, ci: { ...p.ci, goldens: 40, rate: 0.85, redText: '1.5%', redWarnText: '1.5%' } };
    });
    await open(s);
    expect(plain(r!.one('#gates .gnote'))).toBe('Between 70% and 90% either verdict can come, so a verdict states the test, never the agent’s rate. With 40 forked goldens of an agent that passes 85% of the time, 1.5% of CI runs go red.');
    const attempts = r!.byText('#gates table.godds th', 'attempts');
    expect([attempts.getAttribute('data-tip'), attempts.getAttribute('title')]).toEqual([tipCard('attempts', [], 'the attempts it runs on average'), null]);
  });

  it('waits while the dashboard server is away, saying the preview is the last it worked out', async () => {
    await open(fakeServer(DEFAULTS_FILE), () => undefined, 'offline');
    expect(r!.one('#gates .gdef').textContent).toBe('Paused until the dashboard server is back: the preview is the last it worked out.');
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
  await r.until('the panels', () => r!.all('#alerts .cilist').length > 1 && r!.all('#gates .gsays').length === 1);
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
    expect(r!.one('#workflow .wfstate').textContent).toBe(`The same as your repository’s ${FILE}.`);
    expect(r!.all('#workflow header .btn')).toHaveLength(0);
    // Back in north-agent, its change is there still, to write or to turn back.
    await moveTo('north-agent');
    await r!.until('north-agent’s change again', () => r!.all('#workflow .wfstate').length === 1 && on('fix-on-failure') === 'true');
    expect([on('pr-comment'), r!.all('#workflow header .btn').length]).toEqual(['true', 1]);
    await r!.click(r!.one('#fix-on-failure header .switch'));
    await r!.until('north-agent’s file again', () => on('fix-on-failure') === 'false' && r!.all('#workflow header .btn').length === 0);
  });
});
