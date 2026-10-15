/** Projects: several folders behind one dashboard, the list of them, and setting each one up. */
export { ProjectHost, type ProjectContext, type ProjectCounts, type ProjectHostOptions } from './context.js';
export { SUGGEST_LIMITS, checkFolder, countGoldens, describeFolder, projectRoots, suggestFolders } from './folders.js';
export type { FolderCheck, FolderKind, FolderSuggestion, FolderSuggestions, ProjectLanguage, ProjectRoots, SuggestOptions } from './folders.js';
export { displayPath, expandHome, isWithin, projectDbPath, realpathOrNull, shadowlapHome, tildePath } from './paths.js';
export { COMMAND_LIMITS, UPSTREAM_ENV, defaultGolden, goldenPath, modelServerFinding, parseAgentCommand, planRecording, quoteArgs, sameArgv, setupCommands, setupJobArgs, shortRunId, upstreamUrl } from './record.js';
export type { GoldenPathResult, ModelServer, ParsedCommand, RecordConfirmation, RecordPlan, RecordPlanResult } from './record.js';
export { RecordingsError, deleteRecordings, recordingInProgress, storeFilesToDelete } from './recordings.js';
export { ProjectError, ProjectRegistry, REGISTRY_FILE, REGISTRY_VERSION, emptySetup, nameConfirms, projectSlug } from './registry.js';
export type { AddedProject, ConfirmedCommand, ProjectEntry, ProjectErrorCode, ProjectSetup, RegistryOptions, RemovedProject, SetupPatch } from './registry.js';
export { SETUP_STAGES, calibrationOutcome, deriveSetup, earlierStage, emptyStoreFacts, initialSetup, isAttempt, isRecording, isSetupStage, laterStage, runTotals, stageAtLeast, storeFacts, unwrappedTools } from './setup.js';
export type { CalibrationOutcome, EffectiveSetup, RunFact, RunTotals, SetupFindings, SetupStage, SetupState, SetupTool, StoreFacts, WrapSnippet } from './setup.js';
