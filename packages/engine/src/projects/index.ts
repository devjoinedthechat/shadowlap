/**
 * Projects: several folders behind one dashboard, the list of them, and setting each one up. This
 * barrel has everything in the module, for its tests; the engine's index exports the public part by
 * name.
 */
export { ProjectHost, type ProjectContext, type ProjectCounts, type ProjectHostOptions } from './context.js';
export { SUGGEST_LIMITS, checkFolder, countGoldens, describeFolder, listPacks, projectRoots, readPack, suggestFolders } from './folders.js';
export type { FolderCheck, FolderKind, FolderSuggestion, FolderSuggestions, ProjectLanguage, ProjectRoots, SuggestOptions } from './folders.js';
export { displayPath, expandHome, isWithin, projectDbPath, realpathOrNull, shadowlapHome, shadowlapHomeProblem, tildePath } from './paths.js';
export { COMMAND_LIMITS, UPSTREAM_ENV, defaultGolden, freeGoldenPath, goldenPath, isConfirmedCommand, modelServerFinding, parseAgentCommand, planRecording, sameArgv, setupCommands, setupJobArgs, shortRunId, upstreamUrl } from './record.js';
export type { GoldenPathResult, ModelServer, ParsedCommand, RecordConfirmation, RecordPlan, RecordPlanResult } from './record.js';
export { MADE_FOLDERS, RecordingsError, deleteRecordings, madeFiles, recordingInProgress, storeFilesToDelete } from './recordings.js';
export { ProjectError, ProjectRegistry, REGISTRY_FILE, REGISTRY_VERSION, emptySetup, nameConfirms, projectSlug, setupRunOf } from './registry.js';
export type { AddedProject, ConfirmedCommand, ProjectEntry, ProjectErrorCode, ProjectSetup, RegistryOptions, RemovedEntry, RemovedProject, SetupPatch } from './registry.js';
export { LIVE_RUN_MS, SETUP_STAGES, calibrationOutcome, countRunsAndAttempts, deriveSetup, earlierStage, emptyStoreFacts, initialSetup, isAttempt, isLiveRun, isRecording, isSetupStage, laterStage, runTotals, stageAtLeast, storeFacts, unwrappedTools } from './setup.js';
export type { CalibrationOutcome, EffectiveSetup, FactsSource, GoldenTestFact, Inspection, PackFact, RunFact, RunTotals, SetupFindings, SetupStage, SetupState, SetupTool, StoreFacts, WrapSnippet } from './setup.js';
export { StoreReader, readStore, readStoreFacts } from './store-reader.js';
