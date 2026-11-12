import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPS_ONLY_NOTE, Store, type ModelListing, type Task } from '@shadowlap/engine';
import { exportPairsJob, modelsView, readTraining, scoreModelJob, trainingView } from '../src/training.js';
import { ApiError, type Client, type TaskUpdate } from '../ui/api.js';
import { commandText } from '../ui/goldens.js';
import { TaskUpdateDialog, TrainingPage } from '../ui/pages/Training.js';
import type { Price } from '../ui/tests-estimates.js';
import { AppContext, type AppState } from '../ui/state.js';
import { exportCommand, scoreCommand } from '../ui/training.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Training says only what is true: what the pairs and tasks come from, what the last export wrote,
 * which golden's checks are too weak to be a task, that the training loop's request and answer are an
 * example, and, in its dialogs, the command each runs and the file Export pairs writes.
 */

const task = (golden: string, status: Task['status'], note: string | null, extra: Partial<Task> = {}): Task => ({
  golden,
  name: golden.split('/').at(-1)!,
  status,
  note,
  runId: `RUN_${golden.split('/').at(-1)}`,
  takeover: status === 'not-a-task' ? null : { callNo: 5, why: 'where the refund-bug runs were lost', from: 'config' },
  scope: null,
  scopes: [null],
  rewards: status === 'not-a-task' ? null : 'escalate above the limit',
  checks: status === 'not-a-task' ? [] : [{ label: 'issue_refund called 0 times', cap: false }, { label: 'escalate called 1 time', cap: false }],
  after: status === 'not-a-task' ? { live: [], stubbed: [] } : { live: [], stubbed: ['escalate'] },
  prefix: status === 'not-a-task' ? 0 : 4,
  model: status === 'not-a-task' ? null : 'claude-sonnet-5',
  provider: status === 'not-a-task' ? null : 'anthropic',
  callName: status === 'not-a-task' ? null : 'POST /v1/messages',
  tokensAfter: null,
  ...extra,
});

// The demo's goldens: two ready, one with no checks (listed first), and one whose checks only cap spending.
const TASKS: Task[] = [
  task('goldens/01M5GS0TFN', 'ready', null),
  task('goldens/01M5GS0VWV', 'ready', null),
  task('goldens/list-inbox-label-thread-d2a5a7', 'not-a-task', 'it has no checks'),
  task('goldens/refund-flow-budget', 'not-a-task', CAPS_ONLY_NOTE, { checks: [{ label: 'at most 29000 input tokens', cap: true }, { label: 'cost at most $0.05', cap: true }] }),
];

const LISTING: ModelListing = {
  choices: [{ group: 'Anthropic API', id: 'claude-haiku-4-5', via: 'Anthropic API', where: 'Anthropic API', baseUrl: null, flags: ['--model', 'claude-haiku-4-5'], perAttempt: 0.004, local: false }],
  notes: [{ group: 'Ollama, on this machine', note: "isn't running" }],
  tokens: null,
};

/**
 * The page's answers, from the server's own read models over a store with no pairs yet, and Export
 * pairs offered as it is once a blame made some (two of high confidence, one medium).
 */
function views() {
  const s = Store.open(':memory:');
  // Three redaction rules, as the route reads them from the config.
  const read = trainingView(readTraining(s, { tasks: TASKS, redactRules: 3 }));
  s.close();
  const training = { ...read, actions: { ...read.actions, exportPairs: true }, exportDialog: { ...read.exportDialog, high: 2, all: 3 } };
  return { training, models: modelsView(TASKS, [], LISTING) };
}

function page(tab: 'pairs' | 'tasks', started: Array<{ kind: string; fields: Record<string, unknown> }> = []) {
  const { training, models } = views();
  const client = {
    training: () => Promise.resolve(training),
    models: () => Promise.resolve(models),
    jobs: () => Promise.resolve([]),
    startJob: (kind: string, fields: Record<string, unknown>) => {
      started.push({ kind, fields });
      return Promise.resolve({ id: 'j1' });
    },
  } as unknown as Client;
  const app = {
    client,
    exported: false,
    meta: null,
    tick: 0,
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
  };
  return createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(TrainingPage, { tab }));
}

const text = (r: Rendered, selector: string) => r.all(selector).map((el) => el.textContent.replace(/\u00a0/g, ' ').trim());

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('the Training page', () => {
  it('says where pairs and tasks come from, and what the last export wrote', async () => {
    r = await render(page('pairs'));
    await r.until('the page to load', () => r!.all('.pfacts').length > 0);
    expect(r.one('.ph p').textContent).toBe('Answers to prefer, from attempts already in the store, and your goldens as tasks to score.');
    // In two clauses, so with less room than the line needs it breaks between them, not before its last words.
    expect(text(r, '.ph p .ln')).toEqual(['Answers to prefer, from attempts already in the store,', 'and your goldens as tasks to score.']);
    expect(r.document.body.textContent).not.toContain('from failures you fixed');
    // The facts under the header, the last export last and quieter, its card saying what it wrote: main's words, Exported.
    const facts = r.all('.pfacts .metric');
    expect(facts.map((f) => f.textContent.replace(/\u00a0/g, ' '))).toEqual(['0pairs', '2of 4 tasks ready', '0exported']);
    expect(facts[2].querySelector('b')!.className).toBe('q');
    expect(JSON.parse(facts[2].getAttribute('data-tip')!)).toMatchObject({ t: 'Exported', s: 'nothing exported yet' });
    expect(r.document.body.textContent).not.toContain('Left this machine');
    expect(r.one('.ph .eyebrow').textContent).toBe('training data');
  });

  it('names the golden whose checks only cap spending as the one weak checks keep from being a task, and labels the training loop sample an example', async () => {
    r = await render(page('tasks'));
    await r.until('the tasks to load', () => r!.all('table.tasks tbody tr').length === 4);
    const weak = r.byText('b', 'A model learns what the checks reward.').parentNode!.textContent;
    expect(weak).toContain('That’s why refund-flow-budget isn’t a task.');
    expect(weak).not.toContain('list-inbox');
    expect(r.document.body.textContent).toContain('For example, one attempt and the score it answers with:');
    const sample = r.one('pre.trserve').textContent;
    expect(sample).toContain('"run": "<run id>"');
    expect(sample).not.toContain('"from"');
    expect(sample).toContain('{ "score": 0.67,');
    // A golden that is no task has no call to take over.
    const rows = r.all('table.tasks tbody tr').map((tr) => tr.textContent.replace(/\u00a0/g, ' '));
    expect(rows.find((t) => t.includes('refund-flow-budget'))).toContain('no call to take over');
  });

  it('shows the file Export pairs writes and the command it runs, as the format and confidence change', async () => {
    const started: Array<{ kind: string; fields: Record<string, unknown> }> = [];
    r = await render(page('pairs', started));
    await r.until('the page to load', () => r!.all('button').some((b) => b.textContent.trim() === 'Export pairs…'));
    // Its card, as Score model…'s: the action's name without the ellipsis, and what it runs.
    expect(JSON.parse(r.byText('button', 'Export pairs…').getAttribute('data-tip')!)).toEqual({ t: 'Export pairs', s: 'Asks the format and the confidence first', rows: [], cmd: '$ shadowlap export pairs' });
    await r.click(r.byText('button', 'Export pairs…'));
    expect(r.one('.dialog .dfacts').textContent.replace(/\u00a0/g, ' ')).toBe('Redactsby 3 rulesthe store never changesWrites.shadowlap/exports/pairs.jsonlthe job’s drawer offers it for download');
    expect(r.one('.dialog .cmdline').textContent).toBe('$shadowlap export pairs --min-confidence high --format openai-preference --out .shadowlap/exports/pairs.jsonl');
    expect(r.all('.dialog select')[0].children.map((o) => o.textContent)).toEqual(['OpenAI preference fine-tuning', 'prompt, chosen, rejected (TRL)']);
    await r.type(r.all('.dialog select')[0], 'trl');
    await r.type(r.all('.dialog select')[1], 'medium');
    expect(r.one('.dialog .cmdline').textContent).toBe('$shadowlap export pairs --min-confidence medium --format trl --out .shadowlap/exports/pairs.jsonl');
    // Titled and confirmed with its button's name, without the ellipsis.
    expect(r.one('.dialog h3').textContent.replace(/\u00a0/g, ' ')).toBe('Export pairs');
    await r.click(r.byText('.dialog button', 'Export pairs'));
    expect(started).toEqual([{ kind: 'pairs', fields: { format: 'trl', minConfidence: 'medium' } }]);
  });

  it('shows the command Score a model runs for the model picked', async () => {
    r = await render(page('tasks'));
    await r.until('the page to load', () => r!.all('button').some((b) => b.textContent.trim() === 'Score model…'));
    await r.click(r.byText('button', 'Score model…'));
    await r.until('the models to be listed', () => r!.all('.dialog .cmdline').length === 1);
    expect(r.one('.dialog .cmdline').textContent).toBe('$shadowlap tasks score goldens/01M5GS0TFN goldens/01M5GS0VWV --model claude-haiku-4-5 --attempts 5');
    expect(r.one('.dialog p.trnotes').textContent).toBe("Not listed: Ollama, on this machine (isn't running)");
  });
});

describe('the commands the Training dialogs show', () => {
  it('are the ones the server runs for what the dialog sends', () => {
    for (const [format, min] of [['openai-preference', 'high'], ['trl', 'medium']] as const) {
      const job = exportPairsJob({ format, minConfidence: min });
      if ('error' in job) throw new Error(job.error);
      expect(exportCommand(format, min, job.out)).toBe(commandText(job.args));
    }
    const ready = TASKS.filter((t) => t.status === 'ready');
    for (const fields of [
      { model: 'claude-haiku-4-5', baseUrl: null, attempts: 5, goldens: null },
      { model: 'my-finetune', baseUrl: 'http://127.0.0.1:8000/v1/', attempts: 10, goldens: ['goldens/01M5GS0VWV'] },
    ]) {
      const job = scoreModelJob(fields, ready);
      if ('error' in job) throw new Error(job.error);
      expect(scoreCommand(fields, ready.map((t) => t.golden))).toBe(commandText(job.args));
    }
    expect(scoreCommand(null, [])).toBeNull();
  });
});

describe('a task’s Update golden that tests it again', () => {
  const GOLDEN = 'goldens/refund-forked';
  const RETEST: TaskUpdate = { golden: GOLDEN, forkedAt: 3, takeover: 7, normalizers: ['$.metadata.user_id'], rerecords: false, steps: [['normalize', 'add', '--path', '$.metadata.user_id', '--replace', '<ID>'], ['test', GOLDEN]] };
  const CONFIRM = 'c0ffee'.padEnd(32, '0');
  const WHY = `${GOLDEN} is marked fork, so it runs live from where it forks, writes blocked. Live calls are billed by your provider. Confirm it to run it`;

  /** Its dialog, the server asking first before it runs the golden live, as `liveAsk` does. */
  function asked(estimate: Price, sent: Array<Record<string, unknown>>, watched: Array<Promise<unknown>>) {
    const client = { startJob: (_kind: string, fields: Record<string, unknown>) => (sent.push(fields), fields.yes === CONFIRM ? Promise.resolve({ id: 'j1' }) : Promise.reject(new ApiError(409, WHY, CONFIRM))) };
    const app = { client, guard: (fn: () => void) => (fn(), true), watchJob: (p: Promise<unknown>) => void watched.push(p), actionsOff: null, hasKind: () => true, jobs: [] };
    return createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(TaskUpdateDialog, { name: 'refund-forked', update: RETEST, estimate, busy: null, onClose: () => undefined }));
  }

  it('shows the server’s question in its own dialog where it hadn’t said the test runs live, and only then sends the yes', async () => {
    const [sent, watched]: [Array<Record<string, unknown>>, Array<Promise<unknown>>] = [[], []];
    r = await render(asked(null, sent, watched));
    expect(r.all('.dialog .dcost')).toHaveLength(0);
    await r.click(r.one('.dialog .dlg-ok'));
    await r.until('the question', () => r!.all('.dialog dl').length > 0);
    expect(text(r, '.dialog dl')[0]).toContain(WHY);
    expect(text(r, '.dialog .dcost')).toEqual(['Billed by your provider']);
    expect([sent, watched]).toEqual([[{ golden: GOLDEN }], []]);
    await r.click(r.one('.dialog .dlg-ok'));
    await r.until('the yes', () => watched.length === 1);
    expect(sent).toEqual([{ golden: GOLDEN }, { golden: GOLDEN, yes: CONFIRM }]);
  });

  it('sends the yes at once where it said what testing it again bills live, the job keeping that estimate', async () => {
    const [sent, watched]: [Array<Record<string, unknown>>, Array<Promise<unknown>>] = [[], []];
    r = await render(asked({ kind: 'tests', usd: 0.3, ceiling: false, parts: ['live from where it forks'] }, sent, watched));
    expect(text(r, '.dialog .dcost')[0]?.replace(/\s+/g, ' ')).toBe('≈$0.300 · live from where it forks');
    await r.click(r.one('.dialog .dlg-ok'));
    await r.until('the yes', () => watched.length === 1);
    const estimate = { usd: 0.3, ceiling: false };
    expect(sent).toEqual([{ golden: GOLDEN, estimate }, { golden: GOLDEN, estimate, yes: CONFIRM }]);
  });
});
