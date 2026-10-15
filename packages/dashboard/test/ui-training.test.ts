import { describe, expect, it } from 'vitest';
import { lineTone } from '../ui/jobs.js';
import { ENDPOINT, fileName, filterGroups, firstPick, leftNote, noteTrainingCounts, notesLine, onTrainingDialog, pickedOption, pickNote, pipClass, pipTip, requestTrainingDialog, scoreFields, takeTrainingDialog, trainingPalette, whenDone, type TrainingPaletteContext } from '../ui/training.js';
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
  request: { model: id, baseUrl: o.baseUrl ?? null },
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
    option('my-finetune', { group: 'Endpoints scored before', baseUrl: 'http://127.0.0.1:8000/v1', local: true, request: { model: 'my-finetune', baseUrl: 'http://127.0.0.1:8000/v1' }, lastScore: 0.8, note: 'Runs at http://127.0.0.1:8000/v1 · not a paid API · replaces its score of 0.80' }),
  ],
  groups: ['Recorded with', 'Anthropic API', 'Endpoints scored before'],
  selected: 'claude-haiku-4-5\n',
  attempts: [5, 10],
  endpoint: { key: '__endpoint', group: 'Other', label: 'Your own endpoint…', baseUrl: 'http://127.0.0.1:8000/v1', model: 'my-finetune', note: 'Any OpenAI-compatible server, such as vLLM serving the model you’re training. Not a paid API.' },
  notes: [],
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
    expect(scoreFields(DIALOG, '1', DIALOG.endpoint, 5)).toEqual({ model: 'claude-haiku-4-5', baseUrl: null, attempts: 5 });
    expect(scoreFields(DIALOG, '2', DIALOG.endpoint, 10)).toEqual({ model: 'my-finetune', baseUrl: 'http://127.0.0.1:8000/v1', attempts: 10 });
    expect(scoreFields(DIALOG, ENDPOINT, { baseUrl: ' http://127.0.0.1:9000/v1 ', model: ' step-200 ' }, 5)).toEqual({ model: 'step-200', baseUrl: 'http://127.0.0.1:9000/v1', attempts: 5 });
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

  it('offers both until Training was read, then only what there is, and only kinds the server runs', () => {
    noteTrainingCounts(null);
    expect(trainingPalette(ctx(['pairs', 'score']), KINDS).map((c) => c.label)).toEqual(['Export preference pairs…', 'Score a model on the tasks…']);
    expect(trainingPalette(ctx(['pairs']), KINDS).map((c) => c.label)).toEqual(['Export preference pairs…']);
    noteTrainingCounts({ tabs: { pairs: 0, tasks: 2 } } as TrainingView);
    expect(trainingPalette(ctx(['pairs', 'score']), KINDS).map((c) => c.label)).toEqual(['Score a model on the tasks…']);
    noteTrainingCounts({ tabs: { pairs: 3, tasks: 0 } } as TrainingView);
    expect(trainingPalette(ctx(['pairs', 'score']), KINDS).map((c) => [c.label, c.hint, c.group])).toEqual([['Export preference pairs…', 'shadowlap export pairs', 'Actions']]);
    expect(trainingPalette(ctx(['pairs'], [], true), KINDS)).toEqual([]);
  });

  it('opens Training on the right tab and asks the page for the dialog', () => {
    noteTrainingCounts({ tabs: { pairs: 3, tasks: 1 } } as TrainingView);
    const went: string[] = [];
    const heard: string[] = [];
    const off = onTrainingDialog((k) => heard.push(k));
    const [, score] = trainingPalette(ctx(['pairs', 'score'], went), KINDS);
    score!.run();
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
