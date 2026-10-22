import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPS_ONLY_NOTE, Store, type ModelListing, type Task } from '@shadowlap/engine';
import { exportPairsJob, modelsView, readTraining, scoreModelJob, trainingView } from '../src/training.js';
import type { Client } from '../ui/api.js';
import { commandText } from '../ui/goldens.js';
import { TrainingPage } from '../ui/pages/Training.js';
import { AppContext, type AppState } from '../ui/state.js';
import { exportCommand, scoreCommand } from '../ui/training.js';
import { DONE, ESCALATE, ESCALATE_2, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
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

function views() {
  const s = Store.open(':memory:');
  const lost = recordRun(s, [LOOKUP, POLICY, REFUND, DONE], { status: 'failed', meta: { labels: ['refund-bug'] } }).run;
  s.updateRunMeta(lost.runId, { blame: { at: 2, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } });
  for (const steps of [[LOOKUP, POLICY, ESCALATE, DONE], [LOOKUP, POLICY, ESCALATE_2, DONE]]) recordRun(s, steps, { parentRunId: lost.runId, meta: { probe: { of: lost.runId, callNo: 5, passed: true } } });
  const training = trainingView(readTraining(s, { tasks: TASKS }));
  const models = modelsView(TASKS, [], LISTING);
  s.close();
  return { training, models };
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
    registerLayer: () => () => undefined,
  };
  return createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(TrainingPage, { tab }));
}

const text = (r: Rendered, selector: string) => r.all(selector).map((el) => el.textContent.trim());

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('the Training page', () => {
  it('says where pairs and tasks come from, and what the last export wrote', async () => {
    r = await render(page('pairs'));
    await r.until('the page to load', () => r!.all('.kstrip').length > 0);
    expect(r.one('.ph p').textContent).toBe('Answers to prefer, from attempts already in the store, and your goldens as tasks to score.');
    expect(r.document.body.textContent).not.toContain('from failures you fixed');
    expect(text(r, '.kpi .k')).toContain('Exported');
    expect(r.document.body.textContent).not.toContain('Left this machine');
    expect(r.document.body.textContent).toContain('nothing exported yet');
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
    const rows = r.all('table.tasks tbody tr').map((tr) => tr.textContent);
    expect(rows.find((t) => t.includes('refund-flow-budget'))).toContain('no call to take over');
  });

  it('shows the file Export pairs writes and the command it runs, as the format and confidence change', async () => {
    const started: Array<{ kind: string; fields: Record<string, unknown> }> = [];
    r = await render(page('pairs', started));
    await r.until('the page to load', () => r!.all('button').some((b) => b.textContent.trim() === 'Export pairs'));
    await r.click(r.byText('button', 'Export pairs'));
    const dialog = () => r!.one('.dialog');
    expect(dialog().textContent).toContain('It writes .shadowlap/exports/pairs.jsonl in the project folder');
    expect(r.one('.dialog .cmdline').textContent).toBe('$shadowlap export pairs --min-confidence high --format openai-preference --out .shadowlap/exports/pairs.jsonl');
    expect(r.all('.dialog select')[0]!.children.map((o) => o.textContent)).toEqual(['OpenAI preference', 'TRL preference']);
    await r.type(r.all('.dialog select')[0]!, 'trl');
    await r.type(r.all('.dialog select')[1]!, 'medium');
    expect(r.one('.dialog .cmdline').textContent).toBe('$shadowlap export pairs --min-confidence medium --format trl --out .shadowlap/exports/pairs.jsonl');
    await r.click(r.byText('.dialog button', 'Export'));
    expect(started).toEqual([{ kind: 'pairs', fields: { format: 'trl', minConfidence: 'medium' } }]);
  });

  it('shows the command Score a model runs for the model picked', async () => {
    r = await render(page('tasks'));
    await r.until('the page to load', () => r!.all('button').some((b) => b.textContent.trim() === 'Score a model'));
    await r.click(r.byText('button', 'Score a model'));
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
