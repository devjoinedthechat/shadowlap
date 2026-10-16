import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The JSON the CLI prints is a contract: scripts, CI and coding agents read it, and the docs list
 * its fields. Each shape here names the page and the section that list its fields, and the fields.
 *
 * Most shapes are held exactly: a field added, renamed or dropped fails until this list and the
 * docs say so too. The shapes marked `grows` are the dashboard's read models printed as they are
 * (Fixes, Tests, Training, the team store's), which gain a field when a screen needs one: each is
 * held both ways to its docs instead. Every field listed here must still be printed (nothing
 * documented disappears or is renamed), and every field printed must be named in its section (a
 * field added is documented), so a field added together with its words in the docs passes.
 */
export interface Shape {
  /** The page under docs/ that lists the fields: docs/cli.md unless named. */
  page?: string;
  /** The section of that page: a `## ` or `### ` heading, or one of the names a heading lists ("normalize, redact"). */
  section: string;
  fields: readonly string[];
  grows?: true;
}

export const SHAPES = {
  summaryJson: { section: 'run', fields: ['exitCode', 'summary'] },
  summary: { section: 'run', fields: ['runId', 'mode', 'status', 'total', 'byOrigin', 'byKind', 'upstreamRequests', 'injected', 'refused', 'imported', 'tokensNotRespent', 'cost', 'durationMs', 'notReached', 'warnings', 'divergence'] },
  cost: { section: 'run', fields: ['spent', 'saved', 'captured', 'unknownModels'] },
  replayChecks: { section: 'replay', fields: ['exitCode', 'summary', 'checks'] },
  repeat: { section: 'replay', fields: ['attempts', 'report'] },
  repeatReport: { section: 'replay', fields: ['parentRunId', 'attempts', 'forkedAt', 'paths', 'tools', 'distinctFinalResponses', 'succeeded', 'spent', 'saved', 'tokensNotRespent'] },
  show: { section: 'show', fields: ['run', 'summary', 'calls'] },
  showRun: { section: 'show', fields: ['runId', 'parentRunId', 'mode', 'status', 'divergence', 'command', 'codeVersion', 'startedAt', 'endedAt', 'meta'] },
  showCall: { section: 'show', fields: ['runId', 'callNo', 'kind', 'name', 'fingerprint', 'occurrence', 'origin', 'effect', 'requestRef', 'meta', 'at', 'end', 'attempts'] },
  ls: { section: 'ls', fields: ['runId', 'parentRunId', 'mode', 'status', 'calls', 'command', 'codeVersion', 'startedAt', 'endedAt', 'labels', 'forkedAt', 'hasCommand', 'imported', 'partial', 'repeat', 'checks'] },
  label: { section: 'label', fields: ['runId', 'labels'] },
  search: { section: 'search', fields: ['runId', 'callNo', 'kind', 'name', 'field', 'snippet', 'runStartedAt'] },
  diff: { section: 'diff', fields: ['a', 'b', 'identicalPrefix', 'prefix', 'firstRequestDifference', 'responseDifferences', 'after', 'onlyInA', 'onlyInB', 'changes'] },
  diffChanges: { section: 'diff', fields: ['systemPrompt', 'systems', 'tools', 'models', 'code'] },
  importJson: { section: 'import', fields: ['format', 'entries', 'runs', 'skipped'] },
  importRun: { section: 'import', fields: ['runId', 'source', 'key', 'calls', 'labels', 'imported'] },
  calibrate: { section: 'calibrate', fields: ['runId', 'source', 'clean', 'rounds', 'normalizers', 'written', 'added', 'stopped'] },
  rules: { section: 'normalize', fields: ['file', 'exists', 'version', 'error', 'rules'] },
  preview: { section: 'normalize', fields: ['runId', 'calls', 'unreadable', 'partial', 'total', 'rules', 'details'] },
  previewRule: { section: 'normalize', fields: ['n', 'rule', 'count', 'samples', 'reached', 'note'] },
  gc: { section: 'rm', fields: ['dryRun', 'olderThanDays', 'keep', 'cutoff', 'total', 'count', 'runs', 'expect', 'blobs', 'bytes', 'recording', 'recordingCount', 'abandoned', 'abandonedCount', 'deferred', 'store'] },
  gcStore: { section: 'rm', fields: ['path', 'before', 'after', 'free'] },
  doctor: { section: 'doctor', fields: ['name', 'verdict', 'detail'] },
  init: { section: 'init', fields: ['cwd', 'languages', 'packageManager', 'providers', 'frameworks', 'command', 'tools', 'hardcodedBaseUrls', 'modelServer', 'scannedFiles', 'config', 'folder', 'summary', 'unwrapped', 'wrap', 'project'] },

  // Fixes: blame, verify and repair print their reports; fix prints the dashboard's read model of Fixes.
  blame: { page: 'blame.md', section: 'JSON', grows: true, fields: ['runId', 'outcome', 'blamed', 'lost', 'confidence', 'contrast', 'probes', 'oracle', 'recordedFailures', 'rescue', 'modelCalls', 'attemptsPerProbe', 'passesNeeded', 'nonMonotone', 'cost', 'stopReason', 'warnings', 'fix'] },
  blameCall: { page: 'blame.md', section: 'JSON', grows: true, fields: ['callNo', 'step', 'passes', 'attempts'] },
  blameContrast: { page: 'blame.md', section: 'JSON', grows: true, fields: ['callNo', 'recorded', 'rescued', 'rescuedRunId'] },
  blameProbe: { page: 'blame.md', section: 'JSON', grows: true, fields: ['callNo', 'step', 'passes', 'attempts', 'rescued', 'runs'] },
  blameFix: { page: 'blame.md', section: 'JSON', grows: true, fields: ['fixId', 'title', 'status', 'opened'] },
  verify: { page: 'verify.md', section: 'JSON', grows: true, fields: ['verdict', 'reasons', 'warnings', 'summary', 'runs', 'oracle', 'attemptsPerRun', 'passesNeeded', 'change', 'codeVersion', 'cost', 'stopReason', 'verifyId', 'fixes'] },
  verifyRun: { page: 'verify.md', section: 'JSON', grows: true, fields: ['runId', 'role', 'outcome', 'passes', 'attempts', 'deterministic', 'recorded', 'runs'] },
  verifySummary: { page: 'verify.md', section: 'JSON', grows: true, fields: ['targets', 'holdout', 'good'] },
  repair: { page: 'repair.md', section: 'JSON', grows: true, fields: ['outcome', 'why', 'targets', 'holdout', 'good', 'heldOutAutomatically', 'oracle', 'repairer', 'diagnosis', 'anchors', 'candidates', 'accepted', 'patch', 'cost', 'output', 'warnings', 'repairId', 'verifyId', 'fixes'] },
  repairTarget: { page: 'repair.md', section: 'JSON', grows: true, fields: ['runId', 'outcome', 'callNo', 'step', 'steps', 'rescuedRunId', 'rescuedBy', 'reused', 'recorded', 'rescued', 'note'] },
  repairCandidate: { page: 'repair.md', section: 'JSON', grows: true, fields: ['id', 'source', 'strategy', 'why', 'surface', 'file', 'offset', 'before', 'after', 'size', 'state', 'reason', 'verify'] },
  repairOutput: { page: 'repair.md', section: 'JSON', grows: true, fields: ['dir', 'patch', 'report', 'goldens', 'applied', 'branch', 'pr'] },
  fixList: { section: 'fix', grows: true, fields: ['fixes', 'counts'] },
  fixRow: { section: 'fix', grows: true, fields: ['fixId', 'href', 'status', 'title', 'label', 'labels', 'check', 'failing', 'good', 'steps', 'source', 'openedAt', 'verifiedAt', 'appliedAt', 'broken', 'attempts', 'spent'] },
  fixCounts: { section: 'fix', grows: true, fields: ['all', 'open', 'verified'] },
  fixShow: { section: 'fix', grows: true, fields: ['fixId', 'href', 'status', 'title', 'label', 'labels', 'check', 'oracle', 'expect', 'source', 'broken', 'failing', 'good', 'failingRuns', 'goodRuns', 'steps', 'blame', 'blames', 'repair', 'repairs', 'verify', 'defaultStep', 'defaultVerify', 'openedAt', 'verifiedAt', 'appliedAt', 'openedBy', 'attempts', 'spent', 'upstreamRequests', 'actions', 'commands', 'repairer', 'applied'] },
  fixApply: { section: 'fix', grows: true, fields: ['fixId', 'status', 'again', 'patch', 'repairId', 'goldens', 'tests'] },
  fixPr: { section: 'fix', grows: true, fields: ['fixId', 'pr'] },
  fixError: { section: 'fix', grows: true, fields: ['fixId', 'status', 'error'] },
  // Tests: test's report (the GitHub Action reads it), and bisect's.
  test: { section: 'test', grows: true, fields: ['version', 'session', 'revision', 'passed', 'failed', 'interrupted', 'results'] },
  testResult: { section: 'test', grows: true, fields: ['name', 'dir', 'golden', 'mode', 'ok', 'failure', 'message', 'details', 'output', 'seconds', 'runId', 'runs', 'goldenRunId', 'calls', 'upstreamRequests', 'tokensNotRespent', 'divergence', 'checks', 'attempts', 'expect', 'updated'] },
  bisect: { section: 'bisect', grows: true, fields: ['outcome', 'target', 'good', 'bad', 'commits', 'steps', 'first', 'untested', 'why', 'replays', 'tokens', 'upstreamRequests', 'spent', 'seconds'] },
  bisectTarget: { section: 'bisect', grows: true, fields: ['kind', 'name', 'runId'] },
  bisectCommit: { section: 'bisect', grows: true, fields: ['rev', 'short', 'subject', 'author', 'date'] },
  bisectStep: { section: 'bisect', grows: true, fields: ['rev', 'short', 'subject', 'ok', 'skipped', 'result', 'seconds'] },
  // Training: the tasks, a score, and the models to score.
  tasks: { page: 'training.md', section: 'Tasks', grows: true, fields: ['tasks', 'oneSided'] },
  task: { page: 'training.md', section: 'Tasks', grows: true, fields: ['golden', 'name', 'status', 'note', 'runId', 'takeover', 'scope', 'scopes', 'rewards', 'checks', 'after', 'prefix', 'model', 'provider', 'callName', 'tokensAfter'] },
  oneSided: { page: 'training.md', section: 'Tasks', grows: true, fields: ['rewards', 'tasks', 'opposite'] },
  tasksScore: { page: 'training.md', section: 'Scoring a model', grows: true, fields: ['model', 'baseUrl', 'via', 'session', 'mean', 'attempts', 'spent', 'unknownModels', 'skipped', 'tasks'] },
  tasksScoreTask: { page: 'training.md', section: 'Scoring a model', grows: true, fields: ['task', 'takeover', 'why', 'replayed', 'mean', 'spent', 'stopped', 'dropped', 'stored', 'attempts'] },
  tasksScoreAttempt: { page: 'training.md', section: 'Scoring a model', grows: true, fields: ['attempt', 'run', 'score', 'checks', 'spent', 'exitCode'] },
  tasksModels: { page: 'training.md', section: 'Models to score', grows: true, fields: ['choices', 'notes', 'tokens', 'tasks'] },
  modelChoice: { page: 'training.md', section: 'Models to score', grows: true, fields: ['group', 'id', 'via', 'where', 'baseUrl', 'flags', 'perAttempt', 'local', 'lastScore'] },
  modelNote: { page: 'training.md', section: 'Models to score', grows: true, fields: ['group', 'note'] },
  // The team store.
  // The GitHub Action reads push's `fixes` to say whether a CI fix reached the team store.
  push: { section: 'push', grows: true, fields: ['store', 'pullRequest', 'pushed', 'updated', 'unchanged', 'queued', 'repaired', 'refused', 'blobs', 'segment', 'onlyLocal', 'fixes'] },
  pushFixes: { section: 'push', grows: true, fields: ['sent', 'failed', 'repairs'] },
  pull: { section: 'pull', grows: true, fields: ['store', 'pulled', 'merged', 'needPush', 'skippedDeleted', 'missing', 'unknown', 'failed', 'skippedSegments', 'blobs', 'segments', 'inStore', 'byAuthor', 'onlyLocal', 'pullRequests', 'fixes'] },
  pullFixes: { section: 'pull', grows: true, fields: ['pulled', 'merged', 'failed', 'repairs'] },
  share: { section: 'share', grows: true, fields: ['runId', 'url', 'expiresAt', 'note', 'store', 'key', 'bytes', 'redacted', 'rules', 'runs'] },
  storeSet: { section: 'store', grows: true, fields: ['store', 'url', 'provider', 'bucket', 'prefix', 'account', 'region', 'previous', 'config'] },
  storeCheck: { section: 'store', grows: true, fields: ['url', 'credentials', 'steps', 'ok', 'encryption', 'versioning', 'objectLock', 'warnings', 'notes', 'failure', 'pullRequest'] },
  storeShow: { section: 'store', grows: true, fields: ['url', 'store', 'provider', 'providerName', 'bucket', 'prefix', 'region', 'pushedAt', 'pulledAt', 'inStore', 'onlyLocal', 'queued', 'check'] },
  storePolicy: { section: 'store', grows: true, fields: ['provider', 'writer', 'pullRequest', 'notes'] },
  storeCi: { section: 'store', grows: true, fields: ['ci', 'provider', 'file', 'text', 'oidc', 'pullRequests', 'notes'] },
  storePushFromCi: { section: 'store', grows: true, fields: ['ciPush', 'previous', 'config'] },
} as const satisfies Record<string, Shape>;

export type ShapeName = keyof typeof SHAPES;

const pages = new Map<string, string>();
function page(name: string): string {
  let text = pages.get(name);
  if (text === undefined) {
    text = readFileSync(fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url)), 'utf8');
    pages.set(name, text);
  }
  return text;
}

/**
 * A page's section: from its `## ` or `### ` heading, which names it or lists it among several
 * ("normalize, redact"), to the next heading of the same level or above.
 */
export function sectionText(name: string, file = 'cli.md'): string {
  const lines = page(file).split('\n');
  const start = lines.findIndex((l) => {
    const h = /^(#{2,3}) (.+)$/.exec(l);
    return !!h && h[2]!.split(',').map((n) => n.trim()).includes(name);
  });
  if (start < 0) throw new Error(`docs/${file} has no section for ${name}`);
  const level = /^#+/.exec(lines[start]!)![0].length;
  let end = start + 1;
  while (end < lines.length && !(/^#+ /.test(lines[end]!) && /^#+/.exec(lines[end]!)![0].length <= level)) end++;
  return lines.slice(start, end).join('\n');
}

/** Whether a section names a field as code: `field`, or a word of an object or JSON sample (`{ runId, labels }`, "format": …). */
export function names(section: string, field: string): boolean {
  const code = [...section.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0]);
  return code.some((c) => new RegExp(`(?<![\\w$])${field}(?![\\w$])`).test(c));
}

export const keys = (o: unknown) => Object.keys(o as object).sort();
export const fields = (shape: ShapeName) => [...SHAPES[shape].fields].sort();
export const docsOf = (shape: ShapeName) => {
  const s: Shape = SHAPES[shape];
  return sectionText(s.section, s.page);
};

/**
 * How a printed value departs from its shape: fields the shape lists that it doesn't print, and,
 * for a shape held exactly, fields it prints that the shape doesn't list, or, for one that grows,
 * fields it prints that its docs section doesn't name.
 */
export function departures(shape: ShapeName, value: unknown): { missing: string[]; extra: string[] } {
  const printed = keys(value);
  const s: Shape = SHAPES[shape];
  const missing = s.fields.filter((f) => !printed.includes(f)).map((f) => `${shape}.${f} is not printed`);
  const docs = docsOf(shape);
  const extra = printed.filter((f) => !s.fields.includes(f) && (!s.grows || !names(docs, f))).map((f) => `${shape}.${f} is printed but ${s.grows ? `docs/${s.page ?? 'cli.md'} (${s.section}) doesn't name it` : 'not listed'}`);
  return { missing, extra };
}
