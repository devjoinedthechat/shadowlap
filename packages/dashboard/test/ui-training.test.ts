import { describe, expect, it } from 'vitest';
import { jobStatus, lineTone } from '../ui/jobs.js';
import { ENDPOINT, fileName, filterGroups, trainingJobStatus, firstPick, leftNote, leftOutLine, noteTrainingCounts, notesLine, onTrainingCountsChange, onTrainingDialog, pickedOption, pickNote, pipClass, pipTip, requestTrainingDialog, scoreFields, takeTrainingDialog, trainingPalette, whenDone, type TrainingPaletteContext } from '../ui/training.js';
import type { ModelOptionView, PairGroupView, ScoreDialogView, TrainingView } from '../ui/types.js';

// Training's logic without a browser: what a filter shows, the words for times and files, what Score
// a model sends for each choice, and how the palette opens a Training dialog.

const group = (key: string, confidence: 'high' | 'medium'): PairGroupView => ({ key, confidence }) as PairGroupView;

const option = (id: string, o: Partial<ModelOptionView> = {}): ModelOptionView => ({
  group: 'Anthropic API',
  id,
  via: 'Anthropic API',
  where: 'Anthropic API',
  baseUrl: null,
  flags: ['--model', id],
  perAttempt: 0.004,
  local: false,
  key: `${id}\n${o.baseUrl ?? ''}`,
  request: { model: id, baseUrl: o.baseUrl ?? null, goldens: null },
  label: id,
  lastScore: null,
  note: 'Anthropic API · about $0.004 an attempt',
  ...o,
});

const DIALOG: ScoreDialogView = {
  title: 'Score a model on 2 tasks',
  options: [
    option('claude-sonnet-5', { group: 'Recorded with', lastScore: 1, label: 'claude-sonnet-5 · scored 1.00' }),
    option('claude-haiku-4-5'),
    option('my-finetune', { group: 'Endpoints scored before', baseUrl: 'http://127.0.0.1:8000/v1', local: true, request: { model: 'my-finetune', baseUrl: 'http://127.0.0.1:8000/v1', goldens: null }, lastScore: 0.8, note: 'Runs at http://127.0.0.1:8000/v1 · not a paid API · replaces its score of 0.80' }),
  ],
  groups: ['Recorded with', 'Anthropic API', 'Endpoints scored before'],
  selected: 'claude-haiku-4-5\n',
  attempts: [5, 10],
  endpoint: { key: '__endpoint', group: 'Other', label: 'Your own endpoint…', baseUrl: 'http://127.0.0.1:8000/v1', model: 'my-finetune', note: 'Any OpenAI-compatible server, such as vLLM serving the model you’re training. Not a paid API.' },
  notes: [],
  leftOut: [],
};

describe('the pairs a filter shows', () => {
  it('keeps every group for All, and the groups of one confidence otherwise', () => {
    const groups = [group('a', 'high'), group('b', 'medium'), group('c', 'high')];
    expect(filterGroups(groups, 'all').map((g) => g.key)).toEqual(['a', 'b', 'c']);
    expect(filterGroups(groups, 'high').map((g) => g.key)).toEqual(['a', 'c']);
    expect(filterGroups(groups, 'medium').map((g) => g.key)).toEqual(['b']);
  });
});

describe('times, files and pips', () => {
  const now = new Date(2026, 9, 15, 14, 30).getTime();
  it('says when, as the mock does', () => {
    expect(whenDone(now - 20_000, now)).toBe('just now');
    expect(whenDone(new Date(2026, 9, 15, 10, 20).getTime(), now)).toBe('10:20');
    expect(whenDone(new Date(2026, 9, 1, 10, 20).getTime(), now)).toBe('Oct 1, 10:20');
  });

  it('names an export by its file, and stdout for -', () => {
    expect(fileName('.shadowlap/exports/pairs.jsonl')).toBe('pairs.jsonl');
    expect(fileName('-')).toBe('stdout');
    const left = { value: '4', sub: 'pairs, to .shadowlap/exports/pairs.jsonl', href: null, pairs: 4, file: '.shadowlap/exports/pairs.jsonl', at: now - 5_000 };
    expect(leftNote(left, now)).toBe('pairs, to pairs.jsonl · just now');
    expect(leftNote({ ...left, file: null, at: null, sub: 'nothing until you export it' }, now)).toBe('nothing until you export it');
  });

  it('draws a pip for every check passed, some, or none, and says what it opens', () => {
    expect([pipClass({ kind: 'all' }), pipClass({ kind: 'some' }), pipClass({ kind: 'none' })]).toEqual(['', 'part', 'no']);
    expect(pipTip({ attempt: 3, score: 0.5, runId: '01K5' })).toBe('attempt 3 · 0.50 · opens its run');
    expect(pipTip({ attempt: 1, score: 1, runId: null })).toBe('attempt 1 · 1.00');
  });
});

describe('Score a model', () => {
  it('starts on the first model not scored yet, and on your own endpoint when nothing is listed', () => {
    expect(firstPick(DIALOG)).toBe('1');
    expect(firstPick({ ...DIALOG, selected: 'gone\n' })).toBe('0');
    expect(firstPick(null)).toBe(ENDPOINT);
    expect(firstPick({ ...DIALOG, options: [], groups: [], selected: null })).toBe(ENDPOINT);
    expect(pickedOption(DIALOG, '2')?.id).toBe('my-finetune');
    expect(pickedOption(DIALOG, '9')).toBeNull();
    expect(pickedOption(DIALOG, ENDPOINT)).toBeNull();
  });

  it('sends the model as tasks score takes it, with its endpoint, or the endpoint typed in', () => {
    expect(scoreFields(DIALOG, '1', DIALOG.endpoint, 5)).toEqual({ model: 'claude-haiku-4-5', baseUrl: null, attempts: 5, goldens: null });
    expect(scoreFields(DIALOG, '2', DIALOG.endpoint, 10)).toEqual({ model: 'my-finetune', baseUrl: 'http://127.0.0.1:8000/v1', attempts: 10, goldens: null });
    expect(scoreFields(DIALOG, ENDPOINT, { baseUrl: ' http://127.0.0.1:9000/v1 ', model: ' step-200 ' }, 5)).toEqual({ model: 'step-200', baseUrl: 'http://127.0.0.1:9000/v1', attempts: 5, goldens: null });
    // A model that answers only some of the ready tasks is scored on those.
    const some: ScoreDialogView = { ...DIALOG, options: [option('claude-haiku-4-5', { request: { model: 'anthropic:claude-haiku-4-5', baseUrl: null, goldens: ['goldens/refund'] } })] };
    expect(scoreFields(some, '0', DIALOG.endpoint, 5)).toEqual({ model: 'anthropic:claude-haiku-4-5', baseUrl: null, attempts: 5, goldens: ['goldens/refund'] });
    // Not filled in, or not a URL: nothing to send yet.
    expect(scoreFields(DIALOG, ENDPOINT, { baseUrl: 'http://127.0.0.1:9000/v1', model: '  ' }, 5)).toBeNull();
    expect(scoreFields(DIALOG, ENDPOINT, { baseUrl: '127.0.0.1:9000', model: 'm' }, 5)).toBeNull();
    expect(scoreFields(DIALOG, '7', DIALOG.endpoint, 5)).toBeNull();
  });

  it('says where the model runs, and the score an endpoint scored before would replace', () => {
    expect(pickNote(DIALOG, '1', DIALOG.endpoint)).toBe('Anthropic API · about $0.004 an attempt');
    expect(pickNote(DIALOG, ENDPOINT, { baseUrl: 'http://127.0.0.1:8000/v1/', model: 'my-finetune' })).toBe('Any OpenAI-compatible server, such as vLLM serving the model you’re training. Not a paid API. · replaces its score of 0.80');
    expect(pickNote(DIALOG, ENDPOINT, { baseUrl: 'http://127.0.0.1:8000/v1', model: 'step-200' })).toBe(DIALOG.endpoint.note);
    expect(pickNote(null, '1', DIALOG.endpoint)).toBe('');
    expect(leftOutLine([])).toBeNull();
    expect(leftOutLine(undefined)).toBeNull();
    expect(leftOutLine([{ group: 'Anthropic API', models: ['claude-haiku-4-5', 'claude-opus-5-5'], why: "refund-flow: it is an openai request (/v1/completions), which only another model of its own provider can answer" }, { group: 'Recorded with', models: ['gpt-prod'], why: 'refund-flow: its takeover call goes through Azure OpenAI' }])).toBe(
      "Not offered: Anthropic API: claude-haiku-4-5, claude-opus-5-5 (refund-flow: it is an openai request (/v1/completions), which only another model of its own provider can answer) · gpt-prod (refund-flow: its takeover call goes through Azure OpenAI)",
    );
    expect(leftOutLine([{ group: 'OpenAI API', models: ['a', 'b', 'c', 'd', 'e'], why: 'x' }])).toBe('Not offered: OpenAI API: a, b, c and 2 more (x)');
    expect(notesLine([])).toBeNull();
    expect(notesLine([{ group: 'OpenAI API', note: 'OPENAI_API_KEY is not set' }, { group: 'Ollama, on this machine', note: "isn't running" }])).toBe("Not listed: OpenAI API (OPENAI_API_KEY is not set) · Ollama, on this machine (isn't running)");
  });
});

describe('the palette’s Training actions', () => {
  const KINDS = { pairs: 'pairs', score: 'score' };
  const ctx = (kinds: string[], went: string[] = [], exported = false): TrainingPaletteContext => ({
    app: { exported, hasKind: (k: string) => kinds.includes(k), guard: (fn: () => void) => fn(), client: { training: () => new Promise(() => undefined) } },
    go: (to: string) => void went.push(to),
  });
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('offers nothing until Training was read, then only what there is, and only kinds the server runs', () => {
    noteTrainingCounts(null);
    expect(trainingPalette(ctx(['pairs', 'score']), KINDS)).toEqual([]);
    noteTrainingCounts({ tabs: { pairs: 3, tasks: 2 } });
    expect(trainingPalette(ctx(['pairs', 'score']), KINDS).map((c) => c.label)).toEqual(['Export pairs…', 'Score model…']);
    expect(trainingPalette(ctx(['pairs']), KINDS).map((c) => c.label)).toEqual(['Export pairs…']);
    noteTrainingCounts({ tabs: { pairs: 0, tasks: 2 } });
    expect(trainingPalette(ctx(['pairs', 'score']), KINDS).map((c) => c.label)).toEqual(['Score model…']);
    noteTrainingCounts({ tabs: { pairs: 3, tasks: 0 } });
    expect(trainingPalette(ctx(['pairs', 'score']), KINDS).map((c) => [c.label, c.hint, c.group])).toEqual([['Export pairs…', 'shadowlap export pairs', 'Actions']]);
    expect(trainingPalette(ctx(['pairs'], [], true), KINDS)).toEqual([]);
  });

  it('reads the counts again each time it opens, and tells an open palette when what it offers changed', async () => {
    noteTrainingCounts({ tabs: { pairs: 0, tasks: 0 } });
    let answer = { tabs: { pairs: 0, tasks: 0 } };
    let reads = 0;
    const live: TrainingPaletteContext = {
      app: { exported: false, hasKind: () => true, guard: (fn: () => void) => fn(), client: { training: () => (reads++, Promise.resolve(answer as TrainingView)) } },
      go: () => undefined,
    };
    let told = 0;
    onTrainingCountsChange(() => told++);
    try {
      expect(trainingPalette(live, KINDS)).toEqual([]);
      await flush();
      expect([reads, told]).toEqual([1, 0]);
      // A blame made pairs since: the palette opens on what it knew, and is told once the new counts land.
      answer = { tabs: { pairs: 2, tasks: 0 } };
      expect(trainingPalette(live, KINDS)).toEqual([]);
      await flush();
      expect([reads, told]).toEqual([2, 1]);
      expect(trainingPalette(live, KINDS).map((c) => c.label)).toEqual(['Export pairs…']);
      await flush();
      // More pairs change nothing it offers, so an open palette isn't rebuilt for them.
      answer = { tabs: { pairs: 5, tasks: 0 } };
      trainingPalette(live, KINDS);
      await flush();
      expect([reads, told]).toEqual([4, 1]);
      // The page's own read counts too: a task made ready there shows here.
      noteTrainingCounts({ tabs: { pairs: 5, tasks: 1 } });
      expect(told).toBe(2);
    } finally {
      onTrainingCountsChange(() => undefined);
    }
  });

  it('opens Training on the right tab and asks the page for the dialog', () => {
    noteTrainingCounts({ tabs: { pairs: 3, tasks: 1 } });
    const went: string[] = [];
    const heard: string[] = [];
    const off = onTrainingDialog((k) => heard.push(k));
    const [, score] = trainingPalette(ctx(['pairs', 'score'], went), KINDS);
    score.run();
    expect(went).toEqual(['#/training/tasks']);
    expect(heard).toEqual(['score']);
    expect(takeTrainingDialog()).toBe('score');
    expect(takeTrainingDialog()).toBeNull();
    off();
    requestTrainingDialog('export');
    expect(heard).toEqual(['score']);
    expect(takeTrainingDialog()).toBe('export');
  });
});

describe('the drawer while a model is scored', () => {
  it('marks an attempt that missed a check, as the mock does, and leaves one that passed every check plain', () => {
    expect(lineTone('   4 · ✓ the agent exits 0 · ✗ issue_refund called 0 times · ✗ escalate called 1 time · 0.33 01M50X6E4Y')).toBe('y');
    expect(lineTone('  10 · ✗ the agent exits 0 · ✗ escalate called 1 time · 0.00 01M50X6E4Y')).toBe('y');
    expect(lineTone('   1 · ✓ the agent exits 0 · ✓ issue_refund called 0 times · ✓ escalate called 1 time · 1.00 01M50X6C3J')).toBe('');
    // The task's line and the summary keep their own marks.
    expect(lineTone('▸ refund-over-limit · #1–#4 replayed · claude-haiku-4-5 from #5 · writes stubbed')).toBe('');
    expect(lineTone('✓ claude-haiku-4-5 · mean 0.87 · 10 attempts on 2 tasks · ≈$0.104 spent')).toBe('ok');
  });
});

describe('how a Training job ended', () => {
  const attempts = (n: number) => Array.from({ length: n }, (_, i) => ({ attempt: i + 1, score: 1 }));
  const score = (code: number, tasks: Array<{ attempts: unknown[]; stopped?: string | null }>, skipped: unknown[] = [], mean: number | null = 0.87) => ({ kind: 'score', code, result: { model: 'claude-haiku-4-5', mean, tasks, skipped } });

  it('says a score job scored every task and its mean, or how many it scored when a golden no longer replays', () => {
    expect(trainingJobStatus(score(0, [{ attempts: attempts(5) }, { attempts: attempts(5) }]))).toEqual({ text: 'scored · mean 0.87 · exit 0', tone: 'ok' });
    // The demo store's case: refund-over-limit forked at #3 before its takeover, so 3 of its 4 tasks were scored.
    const partly = score(1, [{ attempts: attempts(5) }, { attempts: attempts(5) }, { attempts: attempts(5) }, { attempts: [], stopped: "goldens/refund-over-limit doesn't replay up to #17" }]);
    expect(trainingJobStatus(partly)).toEqual({ text: '3 of 4 tasks scored · exit 1', tone: 'warn' });
    expect(trainingJobStatus(score(1, [{ attempts: attempts(5) }], [{ task: 'goldens/x', reason: 'not a golden' }]))).toEqual({ text: '1 of 2 tasks scored · exit 1', tone: 'warn' });
    expect(trainingJobStatus(score(1, [], [{ task: 'goldens/x', reason: 'unreachable' }], null))).toEqual({ text: 'nothing scored · exit 1', tone: 'err' });
    // The drawer reads it before the CLI's words, which say "Diverged at call" for the golden that stopped.
    expect(jobStatus({ args: ['tasks', 'score'], done: true, ...partly }, ['    ✗ Diverged at call 3 (api POST /v1/messages): 2 calls replayed before divergence'])).toEqual({ text: '3 of 4 tasks scored · exit 1', tone: 'warn' });
  });

  it('says how many pairs an export wrote, or that it exported nothing', () => {
    expect(trainingJobStatus({ kind: 'pairs', code: 0, result: { pairs: 5, file: '.shadowlap/exports/pairs.jsonl' } })).toEqual({ text: '5 pairs written · exit 0', tone: 'ok' });
    expect(trainingJobStatus({ kind: 'pairs', code: 0, result: { pairs: 1, file: '-' } })).toEqual({ text: '1 pair written · exit 0', tone: 'ok' });
    expect(trainingJobStatus({ kind: 'pairs', code: 0, result: { pairs: 0, file: null } })).toEqual({ text: 'nothing exported · exit 0', tone: 'warn' });
    // Still running, another kind, or no result: the drawer reads the CLI's words.
    expect(trainingJobStatus({ kind: 'pairs', code: null, result: { pairs: 5 } })).toBeNull();
    expect(trainingJobStatus({ kind: 'replay', code: 0, result: { pairs: 5 } })).toBeNull();
    expect(trainingJobStatus({ kind: 'score', code: 1 })).toBeNull();
  });
});
