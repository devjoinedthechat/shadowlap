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
  /**
   * Where the section lists this shape's fields, when it lists several shapes' (show lists the run's
   * and each call's): the words just before the parentheses that hold the list. Its fields must be
   * named in that list, not merely somewhere in the section.
   */
  list?: string;
}

export const SHAPES = {
  summaryJson: { section: 'run', fields: ['exitCode', 'summary'] },
  summary: { section: 'run', fields: ['runId', 'mode', 'status', 'total', 'byOrigin', 'byKind', 'upstreamRequests', 'injected', 'refused', 'imported', 'tokensNotRespent', 'cost', 'durationMs', 'notReached', 'warnings', 'divergence'] },
  cost: { section: 'run', fields: ['spent', 'saved', 'captured', 'unknownModels'] },
  // A run with judge checks: what the judge's calls did and cost, apart from the agent's (summary.judge).
  summaryJudge: { section: 'run', fields: ['calls', 'replayed', 'live', 'notAsked', 'upstreamRequests', 'spent', 'saved', 'unknownModels'] },
  replayChecks: { section: 'replay', fields: ['exitCode', 'summary', 'checks'] },
  repeat: { section: 'replay', fields: ['attempts', 'report'] },
  repeatReport: { section: 'replay', fields: ['parentRunId', 'attempts', 'forkedAt', 'paths', 'tools', 'distinctFinalResponses', 'succeeded', 'spent', 'saved', 'tokensNotRespent'] },
  show: { section: 'show', fields: ['run', 'summary', 'calls'] },
  showRun: { section: 'show', list: 'the run as stored', fields: ['runId', 'parentRunId', 'mode', 'status', 'divergence', 'command', 'codeVersion', 'startedAt', 'endedAt', 'meta'] },
  showCall: { section: 'show', list: 'every call as stored', fields: ['runId', 'callNo', 'kind', 'name', 'fingerprint', 'occurrence', 'origin', 'effect', 'requestRef', 'meta', 'at', 'end', 'attempts'] },
  ls: { section: 'ls', fields: ['runId', 'parentRunId', 'mode', 'status', 'calls', 'command', 'codeVersion', 'startedAt', 'endedAt', 'labels', 'forkedAt', 'hasCommand', 'imported', 'partial', 'repeat', 'checks'] },
  label: { section: 'label', fields: ['runId', 'labels'] },
  search: { section: 'search', fields: ['runId', 'callNo', 'kind', 'name', 'field', 'snippet', 'runStartedAt'] },
  diff: { section: 'diff', fields: ['a', 'b', 'identicalPrefix', 'prefix', 'firstRequestDifference', 'responseDifferences', 'after', 'onlyInA', 'onlyInB', 'changes'] },
  diffChanges: { section: 'diff', fields: ['systemPrompt', 'systems', 'tools', 'models', 'code'] },
  importJson: { section: 'import', fields: ['format', 'entries', 'runs', 'skipped'] },
  importRun: { section: 'import', fields: ['runId', 'source', 'key', 'calls', 'labels', 'imported'] },
  calibrate: { section: 'calibrate', fields: ['runId', 'source', 'clean', 'rounds', 'normalizers', 'written', 'added', 'stopped'] },
  rules: { section: 'normalize', fields: ['file', 'exists', 'version', 'error', 'rules'] },
  preview: { section: 'normalize', fields: ['runId', 'calls', 'unreadable', 'partial', 'total', 'returned', 'unmasked', 'rules', 'details'] },
  previewRule: { section: 'normalize', fields: ['n', 'rule', 'count', 'samples', 'reached', 'note', 'returned', 'unmasked'] },
  previewReturned: { section: 'normalize', fields: ['count', 'samples'] },
  previewUnmasked: { section: 'normalize', fields: ['count', 'samples', 'places', 'remedies', 'covered', 'reasons'] },
  previewUnmaskedSample: { section: 'normalize', fields: ['value', 'key', 'callNo', 'kind', 'name', 'in', 'path', 'event'] },
  previewRemedy: { section: 'normalize', fields: ['rule', 'command', 'copies'] },
  gc: { section: 'rm', fields: ['dryRun', 'olderThanDays', 'keep', 'cutoff', 'total', 'count', 'runs', 'expect', 'blobs', 'bytes', 'recording', 'recordingCount', 'abandoned', 'abandonedCount', 'held', 'heldCount', 'deferred', 'store'] },
  gcStore: { section: 'rm', fields: ['path', 'before', 'after', 'free'] },
  doctor: { section: 'doctor', fields: ['name', 'verdict', 'detail'] },
  // check: recordings judged by checks, nothing replayed; and each check as it came out, wherever a command prints one.
  check: { section: 'check', fields: ['expect', 'recordings', 'counts', 'unchecked', 'notes'] },
  checkRecording: { section: 'check', fields: ['runId', 'pack', 'labels', 'source', 'outcome', 'why', 'checks'] },
  checkCounts: { section: 'check', fields: ['passed', 'failed', 'inconclusive'] },
  checkResult: { section: 'check', fields: ['status', 'ok', 'label', 'detail'] },
  init: { section: 'init', fields: ['cwd', 'languages', 'packageManager', 'providers', 'frameworks', 'command', 'tools', 'hardcodedBaseUrls', 'modelServer', 'scannedFiles', 'config', 'folder', 'summary', 'unwrapped', 'wrap', 'project'] },
  // The coding agents' plugin and rule, put into a project (skill-install.test.ts).
  skillInstall: { section: 'skill', fields: ['agent', 'path', 'version', 'before', 'installedVersion', 'outcome', 'files', 'reason'] },
  skillInstallFile: { section: 'skill', fields: ['path', 'action'] },

  // Fixes: blame, verify and repair print their reports; fix prints the dashboard's read model of Fixes.
  blame: { page: 'blame.md', section: 'JSON', grows: true, fields: ['runId', 'outcome', 'blamed', 'lost', 'confidence', 'contrast', 'sameAnswer', 'failedWrite', 'probes', 'oracle', 'recordedFailures', 'rescue', 'modelCalls', 'attemptsPerProbe', 'passesNeeded', 'gate', 'nonMonotone', 'cost', 'judge', 'stopReason', 'warnings', 'fix'] },
  blameCall: { page: 'blame.md', section: 'JSON', grows: true, fields: ['callNo', 'step', 'passes', 'attempts'] },
  blameContrast: { page: 'blame.md', section: 'JSON', grows: true, fields: ['callNo', 'recorded', 'rescued', 'rescuedRunId'] },
  blameProbe: { page: 'blame.md', section: 'JSON', grows: true, fields: ['callNo', 'step', 'passes', 'attempts', 'rescued', 'decision', 'rate', 'runs'] },
  blameFix: { page: 'blame.md', section: 'JSON', grows: true, fields: ['fixId', 'title', 'status', 'opened'] },
  verify: { page: 'verify.md', section: 'JSON', grows: true, fields: ['verdict', 'reasons', 'warnings', 'summary', 'runs', 'oracle', 'attemptsPerRun', 'passesNeeded', 'gate', 'change', 'codeVersion', 'cost', 'judge', 'stopReason', 'verifyId', 'fixes'] },
  verifyRun: { page: 'verify.md', section: 'JSON', grows: true, fields: ['runId', 'role', 'outcome', 'passes', 'attempts', 'decision', 'rate', 'deterministic', 'recorded', 'runs'] },
  verifySummary: { page: 'verify.md', section: 'JSON', grows: true, fields: ['targets', 'holdout', 'good'] },
  repair: { page: 'repair.md', section: 'JSON', grows: true, fields: ['outcome', 'why', 'targets', 'holdout', 'good', 'heldOutAutomatically', 'oracle', 'repairer', 'noRepairer', 'diagnosis', 'anchors', 'candidates', 'accepted', 'patch', 'cost', 'output', 'warnings', 'repairId', 'verifyId', 'fixes'] },
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
  // Preview a change: decisions' report, which the dashboard reads as it is, and migrate's.
  decisions: { section: 'decisions', grows: true, fields: ['decisionsId', 'kind', 'at', 'change', 'command', 'samples', 'runs', 'counts', 'flagged', 'cost', 'tokens', 'retirements', 'notes', 'warnings', 'verify', 'remedies', 'stopReason'] },
  decisionsChange: { section: 'decisions', grows: true, fields: ['model', 'fields', 'from', 'fromCode', 'text'] },
  decisionsRun: { section: 'decisions', grows: true, fields: ['runId', 'golden', 'steps', 'asked', 'rank', 'majority', 'counts', 'cost', 'tokens', 'thinkingStripped', 'refused', 'decisions', 'warnings'] },
  decisionsStep: { section: 'decisions', grows: true, fields: ['callNo', 'step', 'scope', 'rank', 'majority', 'changes', 'recorded', 'now', 'samples', 'model', 'tokens', 'cost', 'thinkingStripped', 'error'] },
  decisionsDifference: { section: 'decisions', grows: true, fields: ['rank', 'kind', 'tool', 'effect', 'before', 'after', 'detail'] },
  decisionsView: { section: 'decisions', grows: true, fields: ['stop', 'stopReason', 'tools', 'text'] },
  // A refusal before anything was asked (no credentials, no such run): decisions' and migrate's.
  decisionsError: { section: 'decisions', fields: ['kind', 'outcome', 'error'] },
  decisionsVerify: { section: 'decisions', grows: true, fields: ['verdict', 'verifyIds', 'runs', 'rule', 'commands', 'spent', 'upstreamRequests', 'reasons'] },
  decisionsSessionVerify: { section: 'decisions', grows: true, fields: ['sessionId', 'kind', 'change', 'verify', 'passes'] },
  decisionsRemedy: { section: 'migrate', grows: true, fields: ['field', 'value', 'leftOut', 'renamedTo', 'why', 'source', 'steps'] },
  migrate: { section: 'migrate', grows: true, fields: ['migrateId', 'kind', 'at', 'from', 'to', 'command', 'decisions', 'changes', 'passes', 'costs', 'set', 'configChange', 'pullRequest', 'files', 'retirements', 'notes', 'warnings', 'stopReason'] },
  migrateCosts: { section: 'migrate', grows: true, fields: ['perRun', 'total', 'tokensPerRun', 'checking'] },
  migrateSet: { section: 'migrate', grows: true, fields: ['flags', 'fields', 'given'] },
  migratePasses: { section: 'migrate', grows: true, fields: ['verdict', 'runs'] },
  migratePass: { section: 'migrate', grows: true, fields: ['runId', 'golden', 'verdict', 'outcome', 'verified', 'tally'] },
  migrateConfigChange: { section: 'migrate', grows: true, fields: ['files', 'patch', 'review'] },
  migrateError: { section: 'migrate', fields: ['kind', 'outcome', 'error'] },
  // Tests: test's report (the GitHub Action reads it), and bisect's.
  test: { section: 'test', grows: true, fields: ['version', 'session', 'revision', 'passed', 'failed', 'inconclusive', 'interrupted', 'results'] },
  testResult: { section: 'test', grows: true, fields: ['name', 'dir', 'golden', 'mode', 'ok', 'verdict', 'failure', 'message', 'details', 'output', 'seconds', 'runId', 'runs', 'goldenRunId', 'calls', 'upstreamRequests', 'tokensNotRespent', 'divergence', 'checks', 'attempts', 'gate', 'expect', 'updated', 'judge', 'injection'] },
  // A golden's gate in test's report: its figures, then what it made of the attempts (test-gate.test.ts holds them).
  testGate: { section: 'test', grows: true, fields: ['kind', 'good', 'bad', 'risk', 'max', 'decision', 'passes', 'attempts', 'outcomes', 'interval', 'passK', 'evidence', 'clean', 'sentence'] },
  testGateHistory: { section: 'test', grows: true, fields: ['kind', 'drop', 'risk', 'window', 'min', 'max', 'decision', 'passes', 'attempts', 'outcomes', 'interval', 'passK', 'evidence', 'clean', 'sentence'] },
  testGateInterval: { section: 'test', grows: true, fields: ['lo', 'hi', 'confidence'] },
  testGatePassK: { section: 'test', grows: true, fields: ['k', 'value'] },
  testGateSprtEvidence: { section: 'test', grows: true, fields: ['kind', 'pass', 'fail', 'upper', 'lower', 'scores'] },
  testGateHistoryEvidence: { section: 'test', grows: true, fields: ['kind', 'history', 'baseline', 'probability', 'probabilities', 'threshold', 'passAt'] },
  // A judge check's entry in `checks`: its verdict, where it came from and what it cost (checks[].judge).
  checkJudge: { section: 'test', fields: ['name', 'model', 'of', 'verdict', 'source', 'cost', 'redactions', 'normalized', 'cut', 'callNo'] },
  testInjection: { section: 'test', list: 'its injection gate', fields: ['resultId', 'attempts', 'obeyed', 'influenced', 'ignored', 'inconclusive', 'allowed', 'verdict', 'reason', 'skipped'] },
  bisect: { section: 'bisect', grows: true, fields: ['outcome', 'target', 'good', 'bad', 'commits', 'steps', 'first', 'untested', 'why', 'replays', 'tokens', 'upstreamRequests', 'spent', 'seconds'] },
  bisectTarget: { section: 'bisect', grows: true, fields: ['kind', 'name', 'runId'] },
  bisectCommit: { section: 'bisect', grows: true, fields: ['rev', 'short', 'subject', 'author', 'date'] },
  bisectStep: { section: 'bisect', grows: true, fields: ['rev', 'short', 'subject', 'ok', 'skipped', 'result', 'seconds'] },
  // Injection tests: the report of injection --json, per run tested by planting or by --clean.
  injection: { section: 'injection', list: 'otherwise, with `--json` it prints', fields: ['templates', 'results', 'totals', 'verdict', 'passed', 'html'] },
  injectionTotals: { section: 'injection', list: '`totals` adds up', fields: ['runs', 'attempts', 'obeyed', 'influenced', 'ignored', 'inconclusive'] },
  injectionPlant: { section: 'injection', list: 'A run tested by planting', fields: ['resultId', 'mode', 'runId', 'golden', 'templates', 'repeat', 'reads', 'unrecordedReads', 'skipped', 'payloads', 'cells', 'attempts', 'baselines', 'totals', 'verdict', 'gate', 'stopReason', 'cost', 'startedAt', 'endedAt'] },
  injectionRead: { section: 'injection', list: 'Each untrusted read', fields: ['callNo', 'name', 'from', 'readAt', 'args', 'planted', 'why'] },
  injectionPayload: { section: 'injection', list: 'Each payload', fields: ['id', 'source', 'shape', 'title', 'text', 'canary'] },
  injectionCell: { section: 'injection', list: 'Each cell', fields: ['read', 'payload', 'verdict', 'attempts', 'obeyed', 'influenced', 'ignored', 'inconclusive', 'runs'] },
  injectionAttempt: { section: 'injection', list: 'Each attempt', fields: ['runId', 'read', 'payload', 'attempt', 'canary', 'verdict', 'why', 'failed', 'plantedAt', 'forkedAt', 'readAt', 'exitCode', 'evidence', 'spent'] },
  injectionTemplateSet: { section: 'injection', list: 'With `--list-templates --json` it prints', fields: ['version', 'updated', 'templates'] },
  injectionEvidence: { section: 'injection', list: 'Each piece of evidence', fields: ['kind', 'callNo', 'tool', 'path', 'value', 'why'] },
  injectionBaseline: { section: 'injection', list: 'Each read\'s baseline', fields: ['read', 'runs', 'writes', 'failed'] },
  injectionGate: { section: 'injection', list: 'The gate', fields: ['obeyed', 'influenced', 'verdict', 'reason'] },
  injectionClean: { section: 'injection', list: 'A run tested with `--clean`', fields: ['resultId', 'mode', 'runId', 'golden', 'read', 'canary', 'neutral', 'unrecordedReads', 'writes', 'attempts', 'gate', 'rule', 'verdict', 'stopReason', 'cost', 'startedAt', 'endedAt'] },
  injectionCleanWrite: { section: 'injection', list: 'Each recorded write', fields: ['callNo', 'name', 'args', 'identifiers', 'attempts', 'gone', 'verdict', 'bound'] },
  injectionCleanAttempt: { section: 'injection', list: 'Each clean attempt', fields: ['runId', 'attempt', 'forkedAt', 'exitCode', 'made', 'gone', 'why'] },
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
  storeSet: { section: 'store', grows: true, fields: ['store', 'url', 'provider', 'bucket', 'prefix', 'account', 'region', 'previous', 'config', 'set'] },
  storeSetChecked: { section: 'store', grows: true, fields: ['store', 'url', 'provider', 'bucket', 'prefix', 'account', 'region', 'previous', 'config', 'set', 'check'] },
  storeSetRefused: { section: 'store', grows: true, fields: ['store', 'url', 'provider', 'set', 'check'] },
  storeCheck: { section: 'store', grows: true, fields: ['url', 'credentials', 'steps', 'ok', 'encryption', 'versioning', 'objectLock', 'warnings', 'notes', 'failure', 'pullRequest'] },
  storeShow: { section: 'store', grows: true, fields: ['url', 'store', 'provider', 'providerName', 'bucket', 'prefix', 'region', 'pushedAt', 'pulledAt', 'inStore', 'onlyLocal', 'queued', 'check'] },
  storePolicy: { section: 'store', grows: true, fields: ['provider', 'writer', 'pullRequest', 'notes'] },
  storeCi: { section: 'store', grows: true, fields: ['ci', 'provider', 'file', 'text', 'oidc', 'pullRequests', 'notes'] },
  storePushFromCi: { section: 'store', grows: true, fields: ['ciPush', 'previous', 'config'] },
  // Production coverage: coverage --json, each behaviour, each golden read, and what --pack made.
  coverage: { section: 'coverage', fields: ['scanId', 'at', 'runs', 'uncovered', 'groups', 'goldens', 'pack'] },
  coverageGroup: { section: 'coverage', list: 'for every behaviour', fields: ['key', 'covered', 'coveredBy', 'path', 'writes', 'unknown', 'outcome', 'runs', 'runIds', 'sources', 'firstSeen', 'lastSeen', 'nearest', 'command', 'packed', 'lastPack'] },
  coverageGolden: { section: 'coverage', list: 'for every golden read', fields: ['golden', 'runId', 'path', 'writes', 'outcome', 'error'] },
  coveragePack: { section: 'coverage', list: 'what each became', fields: ['key', 'golden', 'runId', 'from', 'command', 'mode', 'reason', 'why'] },
  // Error-path presets: test --chaos --json and replay --chaos --summary-json, each recording, each preset, each attempt.
  chaos: { section: 'Error-path presets', fields: ['version', 'session', 'revision', 'presets', 'passed', 'failed', 'inconclusive', 'notApplicable', 'interrupted', 'results'] },
  chaosRecording: { section: 'Error-path presets', list: 'each recording', fields: ['golden', 'runId', 'outcomes', 'judge', 'rule', 'error', 'skipped'] },
  chaosPreset: { section: 'Error-path presets', list: 'each preset', fields: ['preset', 'label', 'verdict', 'callNo', 'target', 'passes', 'attempts', 'detail', 'summary', 'reason', 'runs', 'gate', 'upstreamRequests', 'spent'] },
  chaosRun: { section: 'Error-path presets', list: 'each attempt', fields: ['runId', 'verdict', 'passed', 'exitCode', 'checks', 'reason', 'lastLine'] },
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
  const section = sectionText(s.section, s.page);
  return s.list === undefined ? section : listText(section, s.list);
};

/** The parenthesized list that follows `words` in a section, nested parentheses and all. */
export function listText(section: string, words: string): string {
  const at = section.indexOf(words);
  const open = at < 0 ? -1 : section.indexOf('(', at + words.length);
  if (open < 0) throw new Error(`the section has no list after "${words}"`);
  let depth = 0;
  for (let i = open; i < section.length; i++) {
    if (section[i] === '(') depth++;
    else if (section[i] === ')' && --depth === 0) return section.slice(open, i + 1);
  }
  throw new Error(`the list after "${words}" is never closed`);
}

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
