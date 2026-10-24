export { startDashboard } from './server.js';
export type { Dashboard, DashboardOptions } from './server.js';
export { cliSpawner, JobManager, KEEP_JOBS, MAX_RUNNING, STOP_GRACE_MS } from './jobs.js';
export type { JobBuild, JobBuildContext, JobBuildResult, JobKind, JobRequest, ProjectInfo, SpawnCli, SpawnCliOptions, UploadSource } from './jobs.js';
export { Router } from './router.js';
// The page's links, #/…: one builder for the server, the page and the links a command reports to its job.
export { isLink, links, type LinkView, type RunsLinkType } from './links.js';
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
// Injection tests: the security report (shadowlap injection --html, and the dashboard's), and the read model.
export { injectionReportHtml, type InjectionReportOptions } from './injection-report.js';
export { injectionJob, injectionNeedsLook, injectionResult, injectionResults, injectionLine, injectionTemplatesView, runInjection, toolTrust, type InjectionRow, type ToolTrustRow } from './injection.js';
export { INJECTION_JOB_KIND } from './routes/injection.js';
export type { ExportHtmlOptions, ExportHtmlResult, StaticPayload } from './static.js';
export type { ActionItem, CallDetail, CallRow, LineageNode, ReadOptions, RunDetail, RunListItem } from './api.js';
export type { ActivityIcon, ActivityItem, ActivityPage, ChangesView, JobFile, JobLink, JobListItem, JobView, LiveRun, MetaView, ProjectView, UploadView } from './views.js';
// The run page's read model (run-page.ts): the Provenance tab, show --json, and what runs and calls add for it.
export { provenance, showRunJson } from './api.js';
export { countMasked } from './run-page.js';
export type { CallFacts, MaskCounter, ProvenanceOptions, RunBlame, RunCheck, RunPageFacts, RunProvenance } from './api.js';
// Fixes: the read model behind #/fixes, the Overview's fix numbers, Needs a look and the run page's banners.
export { blameCheckFor, DEFAULT_REPAIRER, fieldChange, fixBundles, fixDetail, fixesSummary, fixForRun, fixHref, fixList, needsLookFixes, patchesToCheck, repairArgv, repairJobArgv } from './fixes.js';
export { repairerProblem } from './repairer-check.js';
export { patchesInTree, patchInTree } from './patch-in-tree.js';
export type { BlameCheck, BlameStep, CandidateVerdict, FixActions, FixBundle, FixBundleAttempt, FixDetail, FixesSummary, FixForRun, FixList, FixRef, FixRow, FixRunRef, FixStep, NeedsLookItem, PatchCheck, RepairStep, RunBlame as FixRunBlame, StepKey, StepState, VerifyRow, VerifyStep } from './fixes.js';
export { ghEnv, ghReader, GH_TIMEOUT_MS, isGithubPr, openPullRequest, parsePrState, prHost, PrStates, readableHosts, remoteHost, storePrStates, type PrRead, type PrReader, type PrState, type PrStatesOptions } from './pr-state.js';
// Tests: the read model behind the Tests screen, and the Settings → CI workflow steps.
export { bisectArgs, bisectChoices, bisectJob, checkedRevision, failingTests, gatePreview, gateResultView, liveTestSession, normalizeAndTestJob, overviewTests, resultLine, runTestsJob, shortReason, testPatterns, testRunBanner, testsSummary, testsView, underChecks, updateGoldensJob, verdictOfResult } from './tests.js';
export type { BisectChoices, BisectMiss, BisectRange, BisectRevision, DivergenceView, FailingTest, FailureView, FoundCommit, GatePreview, GateResultView, GateView, GoldenList, GoldenRow, GoldenSource, GoldenVerdict, HistoryCell, InconclusiveView, SinceResult, TestRunBanner, TestsJob, TestsOptions, TestsSessionView, TestsSummary, TestsVerdict, TestsView } from './tests.js';
export { ACTION, alertFailures, alertsMessage, alertsNeeds, alertsSecret, alertsYaml, FIX_BUDGETS, fixOnFailureNeeds, fixOnFailureNever, fixOnFailureYaml, REPAIRERS, repairerKey, WORKFLOW_FILE } from './ci-yaml.js';
export type { AlertsSettings, BucketCredentials, FixOnFailureSettings, LiveGoldens } from './ci-yaml.js';
export { ciFixBranch, ciTeamStore, ciWorkflows, CI_DEFAULTS, fixPreview, gitFacts, goldenProviders, liveGoldens, liveKeys, parseCiOptions, PROVIDER_KEYS, verifyLine } from './ci-workflows.js';
export type { CiListRow, CiTeamStore, CiWorkflowOptions, CiWorkflowsView, GoldenProviders, PullRequestPreview } from './ci-workflows.js';
export { inTestFamily, sessionBusy, TEST_JOB_KINDS, testsBuild, testsBusy } from './routes/tests.js';
export { choicesHere, choicesInCheckout, commitsHere, commitSubjects, forgetCommits, rangeHere, revisionsHere } from './commits-here.js';
// Settings: one read model per tab; edits go through the engine's config-file module.
export { CLEANUP_DAYS, agentsSection, cleanupArgv, codingAgentsSettings, hideSecrets, hideUrlSecrets, matchingSettings, mcpClientConfig, mcpServerFor, mcpServers, parseJsonc, projectSettings, proposedRules, readShippedDoc, redactionSettings, splitCommandLine, stdioServerName, toolsSettings } from './settings.js';
export type { AgentFile, CodingAgentsSettings, ConfigInfo, HttpHostRow, MatchingSettings, McpRecordedServer, McpServerRow, ProjectSettings, RedactionSettings, RuleForm, RuleRow, SettingsContext, ToolRow, ToolsSettings } from './settings.js';
// The coding agents' skills, as the Claude Code plugin and in .agents/skills: the copy shipped with the CLI, what a project has of it, installing it, and the offer.
export { AGENTS_FOLDER_READERS, CLAUDE_CODE_PLUGIN, CODING_AGENTS, SKILLS, SKILL_PLUGIN, SKILL_PUBLISHED, SKILL_REPOSITORY, TARGETS, claudeConfigDir, codingAgent, installCodingAgent, installedCopy, marketplaceEnabled, sharedSkill, shippedCodingAgents, shippedFiles, shippedVersion, skillOffer } from './agent-skill.js';
export type { AgentInstall, AgentOffer, CodingAgent, InstallResult, InstallState, InstalledCopy, SkillOffer } from './agent-skill.js';
// Training: pairs, tasks and the model picker.
export { approx, exportPairsJob, modelsView, money, PAIRS_EXPORT_FILE, readTraining, scoreDialogView, scoreModelJob, scoreNote, sourceFixes, trainingView } from './training.js';
export type { ModelOptionView, ModelsView, PairFilter, ScoreDialogView, SourceFix, TrainingInput, TrainingOptions, TrainingView } from './training.js';
// The team store's status: the bucket, the last push and pull, runs in the store and only here, the last check.
export { readTeamStoreInput, teamStoreStatus } from './team-store.js';
export type { ReadTeamStoreOptions, TeamStoreInput, TeamStoreStatus } from './team-store.js';
// Provider-neutral parsing of requests and responses lives in the engine, shared with the terminal UI.
export { applyDeltas, normalizeConversation, normalizeResponse } from '@shadowlap/engine';
export type { Block, Conversation, Delta, NormalizedResponse, Turn, TurnBlock } from '@shadowlap/engine';

// Opens the dashboard's link in the default browser through a file only its owner can read: the
// session token never goes on a command line.
export { openInBrowser, redirectPage, type OpenOptions } from './open-browser.js';
