export { startDashboard } from './server.js';
export type { Dashboard, DashboardOptions } from './server.js';
export { cliSpawner, JobManager, KEEP_JOBS, MAX_RUNNING, STOP_GRACE_MS } from './jobs.js';
export type { JobBuild, JobBuildContext, JobBuildResult, JobKind, JobRequest, ProjectInfo, SpawnCli, SpawnCliOptions, UploadSource } from './jobs.js';
export { Router } from './router.js';
export type { Handler, Method, RouteOptions, RouteRequest } from './router.js';
export type { ProjectConfig, RouteContext } from './context.js';
export type { RouteModule } from './routes/index.js';
export { HttpError } from './http.js';
export { MAX_UPLOADS, UploadStore, UPLOAD_LIMIT } from './uploads.js';
export { activity, describeEvent, forkFlag, parseActivityCursor, type EventText } from './activity.js';
export { changesView } from './changes.js';
export { metaView } from './meta.js';
export { actionArgs, actionsFor, callDetail, compare, listRuns, lookupRun, runDetail } from './api.js';
export { exportHtml, withAncestors } from './static.js';
export type { ExportHtmlOptions, ExportHtmlResult, StaticPayload } from './static.js';
export type { ActionItem, CallDetail, CallRow, LineageNode, ReadOptions, RunDetail, RunListItem } from './api.js';
export type { ActivityIcon, ActivityItem, ActivityPage, ChangesView, JobFile, JobLink, JobListItem, JobView, LiveRun, MetaView, ProjectView, UploadView } from './views.js';
// The run page's read model (run-page.ts): the Provenance tab, show --json, and what runs and calls add for it.
export { provenance, showRunJson } from './api.js';
export { countMasked } from './run-page.js';
export type { CallFacts, MaskCounter, ProvenanceOptions, RunBlame, RunCheck, RunPageFacts, RunProvenance } from './api.js';
// Fixes: the read model behind #/fixes, the Overview's fix numbers, Needs a look and the run page's banners.
export { blameCheckFor, DEFAULT_REPAIRER, fixBundles, fixDetail, fixesSummary, fixForRun, fixHref, fixList, needsLookFixes, repairArgv, repairJobArgv } from './fixes.js';
export type { BlameCheck, BlameStep, CandidateVerdict, FixActions, FixBundle, FixBundleAttempt, FixDetail, FixesSummary, FixForRun, FixList, FixRef, FixRow, FixRunRef, FixStep, NeedsLookItem, RepairStep, RunBlame as FixRunBlame, StepKey, StepState, VerifyRow, VerifyStep } from './fixes.js';
export { ghReader, GH_TIMEOUT_MS, isGithubPr, openPullRequest, parsePrState, PrStates, storePrStates, type PrRead, type PrReader, type PrState, type PrStatesOptions } from './pr-state.js';
// Tests: the read model behind the Tests screen, and the Settings → CI workflow steps.
export { bisectArgs, bisectChoices, bisectJob, checkedRevision, failingTests, normalizeAndTestJob, overviewTests, resultLine, runTestsJob, shortReason, testPatterns, testRunBanner, testsSummary, testsView, underChecks, updateGoldensJob } from './tests.js';
export type { BisectChoices, BisectMiss, BisectRange, BisectRevision, DivergenceView, FailingTest, FailureView, FoundCommit, GoldenList, GoldenRow, GoldenSource, HistoryCell, SinceResult, TestRunBanner, TestsJob, TestsOptions, TestsSessionView, TestsSummary, TestsVerdict, TestsView } from './tests.js';
export { ACTION, ALERT_FAILURES, alertsMessage, alertsNeeds, alertsSecret, alertsYaml, FIX_BUDGETS, fixOnFailureNeeds, fixOnFailureNever, fixOnFailureYaml, REPAIRERS, repairerKey, WORKFLOW_FILE } from './ci-yaml.js';
export type { AlertsSettings, FixOnFailureSettings } from './ci-yaml.js';
export { ciWorkflows, CI_DEFAULTS, fixPreview, gitFacts, parseCiOptions } from './ci-workflows.js';
export type { CiListRow, CiWorkflowOptions, CiWorkflowsView, PullRequestPreview } from './ci-workflows.js';
export { TEST_JOB_KINDS, testsBuild, testsBusy } from './routes/tests.js';
export { choicesHere, choicesInCheckout, commitsHere, commitSubjects, forgetCommits, rangeHere, revisionsHere } from './commits-here.js';
// Settings: one read model per tab; edits go through the engine's config-file module.
export { CLEANUP_DAYS, agentsSection, cleanupArgv, codingAgentsSettings, hideSecrets, hideUrlSecrets, matchingSettings, mcpClientConfig, mcpServerFor, mcpServers, parseJsonc, projectSettings, proposedRules, readShippedDoc, redactionSettings, splitCommandLine, stdioServerName, toolsSettings } from './settings.js';
export type { AgentFile, CodingAgentsSettings, ConfigInfo, HttpHostRow, MatchingSettings, McpRecordedServer, McpServerRow, ProjectSettings, RedactionSettings, RuleForm, RuleRow, SettingsContext, ToolRow, ToolsSettings } from './settings.js';
// Training: pairs, tasks and the model picker.
export { approx, exportPairsJob, modelsView, money, PAIRS_EXPORT_FILE, readTraining, scoreDialogView, scoreModelJob, scoreNote, sourceFixes, trainingView } from './training.js';
export type { ModelOptionView, ModelsView, PairFilter, ScoreDialogView, SourceFix, TrainingInput, TrainingOptions, TrainingView } from './training.js';
// The team store's status: the bucket, the last push and pull, runs in the store and only here, the last check.
export { readTeamStoreInput, teamStoreStatus } from './team-store.js';
export type { ReadTeamStoreOptions, TeamStoreInput, TeamStoreStatus } from './team-store.js';
// Provider-neutral parsing of requests and responses lives in the engine, shared with the terminal UI.
export { applyDeltas, normalizeConversation, normalizeResponse } from '@shadowlap/engine';
export type { Block, Conversation, Delta, NormalizedResponse, Turn, TurnBlock } from '@shadowlap/engine';

/** Opens a URL in the default browser. Resolves false when no opener is available. */
export async function openInBrowser(url: string): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
