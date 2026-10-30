export * from './types.js';
export { canonicalize } from './canonical.js';
export { ulid, sha256 } from './ids.js';
export { applyNormalizers, compilePattern, namedPatterns, normalizerApplies, parsePath, rewriteStringsDeep, rewriteText, stripKeysDeep, type RewriteObserver, type UnmaskedAt } from './normalize.js';
// The check every rule's pattern passes before it is compiled.
export { PATTERN_BUDGET_MS, PATTERN_MAX, PatternBudgetError, patternProblem, regexProblem, setPatternBudget, withinPatternBudget } from './safe-regex.js';
export { contextFree, isJsonText, pathReachesResults, reachesResultsOf, rewriteJsonDocument, untouched, type CallScope } from './json-doc.js';
export { REDACTION_EXPORTS, REMEDIES, carriesCredentials, clipChange, credentialFreeCall, credentialFreeCalls, jsonPath, matchedAs, previewRedaction, redactApiPath, redactArgv, redactBytes, redactHeaderValues, redactQuery, redactRun, redactRunDetails, redactRunWithDetails, type PreviewLimits, type RedactRunOptions, type RedactionExport, type RedactionPreview, type RedactionRulePreview, type RedactionUnmasked, type UnmaskedReason, type UnmaskedSample } from './redact.js';
// Credentials in recorded traffic: the one list of credential parameters (credentialParam), the
// headers that carry one, and the stored shapes with them masked, for the sidecar and every copy.
export { nestsDeeper } from './credential-shapes.js';
// A secret's name kept, or masked as a recording made before such names were kept masked it.
export { secretNamesMeta, secretNamesOf, withSecretNames, type SecretNamesRule } from './http.js';
export { CREDENTIAL_HEADERS, CREDENTIAL_PLACEHOLDER, STATE_HEADERS, TOKEN_IN_VALUE, capturedHttp, credentialFreeArgv, credentialFreeBody, credentialFreeCommandLine, credentialFreeCallName, credentialFreeHeaders, credentialFreeQuery, credentialFreeRequest, credentialFreeResult, credentialFreeUrl, credentialHeader, credentialParam, credentialQueryParam, credentialValue, decodedParam, formShaped, maskBytesCredentials, maskChallenge, maskJsonCredentials, maskJsonTextCredentials, maskLocation, maskMultipartBytes, maskPathCredentials, maskTextCredentials, maskUrlCredentials, rawJsonMember, responseBodyWithoutCredentials, resultBlob, sameCommandLine, withoutCredentials, withoutStoredCredentials } from './http.js';
export { calibrationTarget, covered, generalize, proposeNormalizers, type CalibrationStep, type Proposal } from './calibrate.js';
export { asParsed, isRawNumber, matchable, parseJsonExact, reportable } from './json-exact.js';
export { multipartContents, multipartView, parseMultipart, type MultipartContent, type MultipartPart, type MultipartView } from './multipart.js';
export { CLOCK_PLACEHOLDERS, CLOCK_WINDOW_MS, maskClock, maskClockText, nearClock, type ClockMode, type ClockReference, type ClockSeen } from './clock.js';
export { BUILTIN_STRIPPED_KEYS, CLAUDE_CODE_SESSION, FINGERPRINT_VERSION, apiCallName, apiNumbers, fingerprintApi, fingerprintMisc, fingerprintTool, isClaudeCodeSession, maskClaudeCodeSession, maskGeminiCallIds, normalizersHash, queryPairs } from './fingerprint.js';
export type { ApiRequestShape, Fingerprinted } from './fingerprint.js';
export { noFullTextSearch, SCHEMA_VERSION, Store, storeView } from './store.js';
export type { StoreOf, StorePartName } from './store.js';
export type { CreateRunInput, NewStoredEvent, SearchState, StoredEvent } from './store.js';
export type { SqlValue } from './store.js';
// The sidecar's writes queued while another process holds the store, and the ids of runs it starts before they are written.
export type { QueuedWrites } from './store.js';
export { ulidNow } from './store/core.js';
export type { FixData, FixLink, FixLinkKind, FixStatus, PulledFrom, StepRerun, StoredBlame, StoredFix, StoredRepair, StoredVerdict, VerdictStanding } from './store.js';
export { FIX_STATUSES, FixIdError, GOOD_LABEL, applyLeft, checkKey, cleanTitle, coversCheck, fixCost, fixLabelInfo, fixLabels, fixOfRun, fixRecords, joinableFix, markFixApplied, newFixId, prNumber, recordBlame, recordRepair, recordVerdict, repairToApply, resolveFix, setFixTitle, settleAppliedFixes, verdictCounts } from './fixes.js';
export type { BlameToRecord, FixCost, FixRecords, RecordedBlame, RecordedRepair, RecordedVerdict, RepairToRecord, VerdictToRecord } from './fixes.js';
// A run by its full id or the unique prefix the CLI prints, for the dashboard's routes and the fix jobs.
export { lookupRun } from './run-lookup.js';
// The commands a repair from a fix and a verify of it run, and the yes they need first, as the
// dashboard builds them, so the terminal UI runs the same lines and asks about the same runs.
export { DEFAULT_REPAIRER, agentOfArgv, agentOfRun, askConsent, consentKey, expectArgs, findProgram, fixRunArgs, jobConsent, keepArgs, labelSelectsFix, leftWords, needsConsent, noFixToTry, repairArgv, repairJobArgv, repairerProblem, saidYes, scopeArg, selectedRuns, shownBlame, verifyArgv, type JobConsent } from './fix-jobs.js';
// The check a blame starts from when nobody names one, as the dashboard and the terminal UI pick it.
export { blameCheckFor, checkSuggestion, configExpect, failedCheckLabels, labelledFixes, type BlameCheck } from './fix-jobs.js';
// The tests entry a run is judged by when it was given no --expect (the CLI's replays, the dashboard's Run blame).
export { recordingsOfRun, testsEntryFor } from './run-checks.js';
// How a check came out (passed, failed, inconclusive, not applicable), read the same way from any run or test result.
export { CHECK_STATUSES, STATUS_WORDS, checkOutcome, checkStatus, countStatuses, statusTally, type StoredCheckLike } from './check-status.js';
export type { NewTestResult, NewTestSession, TestFailure, TestResult, TestResultData, TestSession } from './store.js';
export { looksGenerated, maskedChange, normalizeAddArgs, normalizeAddCommand, unmaskedHints, valueHints, volatileValue, volatileValues, type VolatileValue, type VolatileValues } from './volatile.js';
export type { TeamFixRow, TeamRunRow, TeamRunState, TeamSyncRow } from './store.js';
// The team store's counts, by run (attempts filed under their run): Settings → Store, Needs a look, store show.
export { abandonedRuns, teamRunCounts, type TeamRunCounts } from './team-runs.js';
export { recordEvent, type EventKind, type RecordEventInput } from './events.js';
export { ciProvider, resolveAuthor, type AuthorOptions } from './author.js';
// Whether a run still `running` has a process recording it (gc, Settings).
export { SILENT_OWNED_MS, SILENT_UNKNOWN_MS, processAlive, recorderGone, type RunOwner } from './liveness.js';
// shadowlap.config.json as a file the CLI and the dashboard both edit.
export { CONFIG_FILE, ConfigBusyError, ConfigConflictError, ConfigFileError, DEFAULT_REPLACE, NO_CONFIG, RULE_KINDS, RuleError, addRule, addRules, configClock, configFilePath, describeRule, editConfigFile, editWhenFree, findRule, parseRules, readConfigFile, readRules, removeRule, ruleNoun, setClock, validateRule } from './config-file.js';
export type { ConfigEvent, ConfigFile, EditOptions, RuleAdded, RuleList } from './config-file.js';
// The lock file those edits take, for any small file several Shadowlap processes change.
export { LOCK_STALE_MS, releaseLock, takeLock, withLockFile, type HeldLock, type LockOptions } from './lock-file.js';
// Projects: the list of folders opened in the dashboard, folder suggestions, setup and recording from it.
export { ProjectError, ProjectHost, ProjectRegistry, emptySetup, nameConfirms, projectDbPath, setupRunOf, tildePath } from './projects/index.js';
export { checkFolder, describeFolder, suggestFolders } from './projects/index.js';
export { UPSTREAM_ENV, defaultGolden, freeGoldenPath, goldenPath, modelServerFinding, parseAgentCommand, planRecording, setupCommands, setupJobArgs } from './projects/index.js';
export { AGENT_NODE_MIN, SETUP_STAGES, calibrationOutcome, deriveSetup, emptyStoreFacts, nodePinTooOld, readStoreFacts, runTotals, stageAtLeast, storeFacts, unwrappedTools } from './projects/index.js';
export type { AddedProject, ConfirmedCommand, ProjectContext, ProjectCounts, ProjectEntry, ProjectErrorCode, ProjectHostOptions, ProjectSetup, RegistryOptions, RemovedProject } from './projects/index.js';
export type { FolderCheck, FolderKind, FolderSuggestion, FolderSuggestions, SuggestOptions } from './projects/index.js';
export type { GoldenPathResult, ModelServer, RecordConfirmation, RecordPlan, RecordPlanResult } from './projects/index.js';
export type { CalibrationOutcome, EffectiveSetup, GoldenTestFact, Inspection, PackFact, RunFact, RunTotals, SetupFindings, SetupStage, SetupState, SetupTool, StoreFacts, WrapSnippet } from './projects/index.js';
export { bringRequest, loadApiRequest, manifestRefs, storeApiRequest } from './manifest.js';
export { ACCOUNT_HEADERS } from './account-headers.js';
export { compareRuns, formatComparison, runChanges, runsDiffer, toolDefinitions, type RunCourse } from './compare.js';
export { requestPathLabel } from './request-paths.js';
export { describeChanges, type RunChanges } from './changes.js';
export type { CallDifference, ComparedIntervention, RunComparison } from './compare.js';
export type { RequestManifest } from './manifest.js';
export { deepEqual, firstDifference, headerDiff, hintsFor, isHeaderEntry, isQueryEntry, queryDiff, structuralDiff } from './diff.js';
export { DEFAULT_REPLAY_OPTIONS, isPlainRead, Session } from './session.js';
export type { Decision, ReplayOptions, ResolveInput, SessionOptions } from './session.js';
export { divergenceLine, endedEarlyCount, extraReadsLine, formatDivergence, formatSummary, formatTokens, plain, replayedBeforeWords, storedModelResolver, summarizeRun } from './report.js';
export type { ModelResolver, SummaryOptions } from './report.js';
// Judge checks: the reserved scope replay strictness leaves out, what a judge reads, the request it is sent, its verdict and its cost.
export { JUDGE_INSTRUCTIONS, JUDGE_KEYS, JUDGE_REQUEST_VERSION, JUDGE_SCOPE, MATERIAL_LIMIT, RESERVED_SCOPE_PREFIX, VERDICT_SCHEMA, agentCallsOf, claudeTakes, escapeMaterial, isJudgeCall, judgeAskId, judgeCallsOf, judgedAnswers, judgeMaterial, judgePrompt, judgeRequest, judgeRules, judgeTarget, matchedClockOf, materialDifference, materialOfRequest, openaiTakesReasoningEffort, openaiTakesTemperature, reachesJudgeRequest, readVerdict } from './judge.js';
export type { ClaudeTakes, GivenAnswer, JudgeAsk, JudgeMaterial, JudgeProvider, JudgeReads, JudgeRequest, JudgeVerdict, MatchMasks, MaterialResult } from './judge.js';
export { aboutUsd, judgeLine, judgeParts, summarizeJudge } from './report.js';
export { DEFAULT_PRICES, canonicalModel, estimateCost, formatDuration, formatUsd, priceFor, shortModel } from './prices.js';
export type { Price } from './prices.js';
export { EXTERNAL_COMMAND, NO_COMMAND, PACK_FORMAT, PACK_GITATTRIBUTES, PACK_VERSION, TEST_COMMAND, asImportedRun, asTheyStand, commandIsImported, hasRecordedCommand, heldFrom, importedCommandSource, packRun, unpackRun, withoutCommand, writePackAttributes } from './pack.js';
export { CONTROL, PACK_LIMITS, PackError } from './pack-schema.js';
export { callRefs, validateCall, validateRun } from './pack-schema.js';
export { decodedSegment, quoteArgv, safeLine, safeText } from './text.js';
// Text safe in the Markdown GitHub renders, for pull request bodies, comments and job summaries.
export { markdownCode, markdownFence, markdownText } from './markdown.js';
export { shortCallName } from './labels.js';
export { ORIGIN_CODE, ORIGIN_CODES, ORIGIN_OF_CODE, ORIGIN_RANK, attemptBundles, binOrigins, checksOf, classifyRun, countOrigins, displayOrigin, emptyOriginCounts, failedChecks, filedTestAttempt, isFailedOutcome, kindLabel, lostAt, notableOrigin, originCells, outcomeLabel, pulledRun, runKind, runOutcome, withAttempts, type CheckCounts } from './classify.js';
export { deletionPlan, type DeletionPlan } from './run-deletion.js';
// Which runs are attempts: the one rule the dashboard's counts, lists and run page go by.
export { attemptKindOf, countAttempts, isAttempt, rescuedForks, type RoleContext, type RoleFacts } from './run-roles.js';
// A run's kind in words, and the actions a run and a call offer as CLI commands: the terminal UI's
// and the dashboard's, here so the dashboard needs nothing of the terminal UI.
export { kindFacts, modelResolver, runLabel, type LabelledRun } from './run-label.js';
// What the dashboard and the terminal UI both say of a run: why it failed, how an attempt came out,
// what a fork did differently from its parent and how each ended, and the good/bad key.
export { attemptVerdict, checkFailed, FAILURE_WORDS, failureReason, keptAttemptVerdict, lostRange, lostWords, type AttemptVerdict, type FailureReason } from './run-verdicts.js';
export { compareFork, forkEnd, MAX_TOOL_CALLS, type ForkChange, type ForkChangeKind, type ForkComparison, type ForkEnd, type ForkWrite } from './fork-changes.js';
export { markChange, markKey, MARKS, markToast, type RunMark } from './run-marks.js';
// A request's body, read whole or not at all, for every server here; node:sqlite as every store opens it.
export { BodyTooLarge, MODEL_BODY_LIMIT, readBody, type BodyLimits } from './body.js';
// The one test of whether a value is an object to read fields from, and the one reading of what a caught
// value says: a lint rule refuses another of either.
export { isObject } from './is-object.js';
export { messageOf } from './message-of.js';
export { rollBack } from './sqlite.js';
export { actionContext, actionMissing, bisectAction, buildActions, CAPTURE_NOTE, forkArgs, forkCommand, forkMenuTitle, isUserInput, notRun, PLANTED_INSTRUCTIONS, recordingNow, splitCommand, terminalActions, type Action, type ActionContext } from './run-actions.js';
export type { AttemptKind, ClassifiableMeta, ClassifiableRun, ClassifyContext, DisplayOrigin, KindFacts, OriginCode, OriginCounts, OutcomeContext, RunClass, RunKind, RunOutcome } from './classify.js';
export { IMPORT_FILE_FORMATS, guessImportFormat, type ImportFileFormat, type ImportFormatGuess } from './import-format.js';
export { withoutPrompt } from './prompt.js';
export { GATEWAY_UNCHANGED, SHAPE_NAMES, applyInjection, isGatewayRequest, formatToolFailure, literalValue, modelInRequest, noLateSystemMessage, parseToolFailure, placeFields, placeInjection, plantInResult, plantInToolResult, refused, requestShape, setRequestFields, switchModel, toolFailureError } from './interventions.js';
export type { InjectAs, InjectionPlace, Refusal, RequestShape, ToolFailure } from './interventions.js';
export { DATASET_FORMATS, datasetRows, type DatasetExample, type DatasetFormat } from './dataset.js';
export { indexSearch, MATCH_END, MATCH_START, searchCalls, searchExpression, searchIndexBehind, updateSearchIndex, type SearchHit, type SearchIndexRun } from './search.js';
export { LABEL_MAX, NOTE_MAX, cleanLabel, withLabels, withNote } from './labels-notes.js';
export { formatRepeats, pathOf, summarizeRepeats } from './repeat.js';
export { describeBlocks, describeRescue, formatBlame, lostWhere, maxProbes, notTheAnswer, probeBound, probeFinding, probeTally, probeVerdict, probeWord, rescueRule, searchBlame, unrescuedWhy, unrescuedWords, unsettledFirst } from './blame.js';
export type { BlameAttempt, BlameContrast, BlameOutcome, BlameProbe, BlameReport, BlameSearchOptions, BlameSearchResult, Confidence, PinCheck, ProbeVerdict } from './blame.js';
export { decideVerify, eachRun, footprintDelta, footprintOf, formatVerify, gateShort, gateVerdict, keptTally, keptVerdict, outcomeOf, runVerdict, unsettledReason, verifyRule } from './verify.js';
// Blame's calibrated search (the risk spent across its probes, the range it reports and its bound),
// verify's test of a good run against its own baseline, and the isotonic fit both read rates with.
export { blameSpan, confidenceOf, confidenceWhy, decidePin, pinRisk, pinRule, pinWords, pooledRates, probeClaim, probeGate, probeRisk, unrescuedHead } from './blame.js';
export { antitonic, type Fitted } from './isotonic.js';
export { addPair, baselineShort, clopperPearsonBound, decideAgainstHistory, decideAgainstHistoryAround, decidePaired, decidePairedAround, describeBaselineRule, dropBound, dropEndsRisk, historyBounds, historyDrop, historyOdds, KEPT_DEFAULTS, KEPT_MAX, NO_PAIRS, pairedBrokenLog, pairedDrop, pairedKeptLog, pairedOdds, pairedWorstCase, pairsOf } from './noninferiority.js';
export type { BaselineDecision, BaselineOdds, BaselineRule, BaselineSource, DropBound, PairCounts } from './noninferiority.js';
// decisions' control arm: a change ranked only beyond the model's own variation, by exact tests.
export { consequence, CONTROL_MIN_SAMPLES, CONTROL_RISK, rankBeyondNoise } from './control-arm.js';
export { fisherGreater, permutationGreater } from './exact-tests.js';
// Statistical gating: verdicts with stated error rates on attempts that vary (test's gate, verify, blame).
export { BASELINE_DEFAULTS, BASELINE_PASS_AT, BLAME_DEFAULTS, GATE_MAX_ATTEMPTS, PASS_K_SHOWN, RECORDING_BASELINE, SPRT_DEFAULTS, atLeast, atMost, attemptsToFail, attemptsToPass, baselineOf, betaCdf, betaPdf, binomialTail, countOdds, decide, decideCount, decideCountUnavailable, decideUnavailable, decisionWord, describeGate, dropProbability, formatPassK, formatTally, gateLimit, gateOdds, gateOddsAt, gateOf, gateResult, gateSentence, lnGamma, normalQuantile, parseGate, passesPerFailure, passHatK, percent, runsRed, sprtBounds, sprtScore, sprtStep, verdictLine, wilson } from './stats.js';
// eslint-disable-next-line @typescript-eslint/no-deprecated -- the bound's old name, kept for code written against it (docs/engine.md)
export { wilsonBound } from './stats.js';
export type { BaselineEvidence, BaselineGate, Gate, GateDecision, GateHistory, GateOdds, GateOutcome, GateResult, SprtBounds, SprtEvidence, SprtGate, Tally } from './stats.js';
// Bounds that hold however a gate stopped (rv-gates).
export { boundOf, clopperPearson, confidencePercent, confidenceSequence, countInterval, gateInterval, rateBound, riskPercent, stagewiseInterval, tallyInterval } from './stats.js';
export type { BoundMethod, GateStop, RateBound, RateInterval, SprtFigures } from './stats.js';
// A provider that can't answer says nothing about the agent: retried, never counted (rv-gates).
export { UNAVAILABLE_RETRY, attemptsInARow, providerUnavailable, retryAfter, retryDelay, sessionInARow, sessionUnavailableReason, unavailableReason, unavailableStatus, unavailableStop, type Unavailable } from './unavailable.js';
// A golden's baseline for a gate against its history, pooled from the store's test history.
export { attemptsOf, gateHistory, judgedUnder, notBaseline, recentAttempts, sessionAttempts, testResultVerdict, type HistoryFilter, type HistorySession, type PooledHistory } from './gate-history.js';
// One risk for a test session, split across its gated goldens (rv-gates).
export { COUNTS_AT, DECLINE_AT, INCONCLUSIVE_AT_GOOD, RECORD_WINDOWS, SUITE_RISK, planSuite, predictive, type PlannedGolden, type SuiteGolden, type SuitePlan } from './suite.js';
export { applyEdit, caseDetails, checkEdit, commitTitle, editSize, findAnchors, forbiddenDetails, formatRepair, gitApplyCommand, NO_REPAIRER, noRepairerOf, patchFiles, REPAIR_FILE_LIMIT, repairNeverRewrites, repairMarkdown, repairPatchProblem, targetWhere, unifiedDiff } from './repair.js';
export type { Anchor, CandidateState, EditCheck, ProposedEdit, RepairCandidate, RepairOutcome, RepairRange, RepairReport, RepairTarget, SourceFile, Surface } from './repair.js';
// Placeholders a rewrite keeps, and its growth before anything runs (repair).
export { CHARS_PER_TOKEN, placeholders, rewriteGrowth, templateSyntax } from './repair.js';
export type { Placeholder, TemplateSyntax } from './repair.js';
export type { Footprint, RunVerdict, VerifiedRun, VerifyAttempt, VerifyDecision, VerifyOutcome, VerifyReport, VerifyRole } from './verify.js';
export type { RepeatAttempt, RepeatAttemptInput, RepeatReport } from './repeat.js';
export { parseSse } from './sse.js';
export { encodeEventStreamFrame, eventStreamFrames, eventStreamMessages, type EventStreamFrame } from './eventstream.js';
export type { SseEvent } from './sse.js';
export { normalizeConversation } from './conversation.js';
export type { Conversation, Turn, TurnBlock } from './conversation.js';
export { applyDeltas, finalAnswer, normalizeResponse } from './responses.js';
export type { Block, Delta, NormalizedResponse } from './responses.js';
export type { PackOptions, PackResult, RecordingMismatch, UnpackResult } from './pack.js';
export { goldenNeedsConsent, goldensNeedingConsent, packHeadRun, packTracked, trackedPacks } from './golden-consent.js';
export type { Palette } from './report.js';
export { conversationRequest, conversationRequestFor, LiveConversations, Lru, responseInfo, runConversations, runStamp } from './conversations.js';
export type { CallConversation, ConversationOptions, ConversationSpan, RequestedTool, RunConversations } from './conversations.js';
export { CACHE_MISS_MIN_TOKENS, cacheMisses, cacheRead, cacheUse, importedRecording, runCache, runCacheUse, sumCacheUse } from './cache.js';
export { wholeInput } from './tokens.js';
export type { CacheMiss, CacheUse, CacheUseMiss, CacheUseOptions, RunCache, RunCacheUse } from './cache.js';
export { notWaited, recordedDurations } from './waits.js';
export type { NotWaited, RunSelection } from './waits.js';
export { inferInterventions, overrideSources, recordNotRecorded, redactRunFacts, runInterventions, toolResultLine, unrecordedProjectTools } from './run-facts.js';
// Tools the model called that a run recorded no call of, read from its answers (contract: name, count, firstCallNo, effect).
export { FENCED_BUILT_INS, fromClaudeCode, mcpToolName, parseUnrecordedConfig, toolNameEffect, UNRECORDED_KEY, unrecordedEffect, unrecordedFix, unrecordedTools, type UnrecordedEffect, type UnrecordedFix, type UnrecordedOptions, type UnrecordedTool } from './unrecorded-tools.js';
// A run's about line: one quiet line that says what the run was, worked out from it and never edited.
export { ABOUT_FROM, ABOUT_MAX, aboutOf, batchInput, changeWords, firstSentence, goldenWords, sourceWords } from './about.js';
export type { AboutFacts, AboutFrom, AboutIntervention, RunAbout, RunAsk } from './about.js';
export { runAsk, type RunAskOptions } from './about-ask.js';
export type { InterventionFlag, OverrideSources } from './run-facts.js';
export { showJson } from './show.js';
export type { ShowJson } from './show.js';
// Training: preference pairs from attempts, goldens as tasks, models to score them on, and the
// translation that lets a model of another provider take over a recorded conversation.
export { contextLine, countPairs, findPairs, pairRows, PAIR_FORMATS, PAIR_SHAPES } from './pairs.js';
export type { Pair, PairAnswer, PairConfidence, PairFormat, PairRowsOptions, PairSource, PairSourceKind, PairsResult } from './pairs.js';
export { answersNothing, attemptScore, averageTokens, CAPS_ONLY_NOTE, defaultTakeover, describeTask, entryFor, goldenPaths, inconclusiveTestNote, inconclusiveWhy, isInconclusiveNote, isModelRequest, isPack, isRecordedInput, INCONCLUSIVE_TEST_NOTE, matchTask, NO_COMMAND_NOTE, oneSided, parseTaskFields, projectPath, readGolden } from './tasks.js';
export type { Golden, InconclusiveWhy, OneSided, Takeover, Task, TaskCheck, TaskFields, TaskInput, TaskStatus } from './tasks.js';
export { anthropicBase, choiceTarget, endpointVia, isLoopback, listingInput, listModelChoices, mainRefusal, modelReach, ollamaBase, openAIBase, OFFICIAL, refusedLine } from './models.js';
// A rule the config already has, for a value a divergence shows (test --update, Training's Update the golden).
export { ruleInForce } from './volatile.js';
export type { ListModelsInput, ModelChoice, ModelListing, ModelReach } from './models.js';
export { anthropicEventList, anthropicMessageEvents, anthropicMessageToOpenAIChat, anthropicToOpenAIChat, awsErrorType, chatCompletionChunks, chatCompletionOf, chatShapeOf, errorBody, errorMessage, openAIChatToAnthropic, openAIChatToAnthropicMessage, openAITools, untranslatable } from './translate.js';
export type { AnthropicMessage, ChatCompletion, ChatShape, OpenAITool, ToOpenAIOptions, TranslatedRequest } from './translate.js';
export { awsEvent, chatCompletionToConverse, converseStreamBody, converseToOpenAIChat, eventStreamHeaders, type ConverseResponse, type ConverseStopReason } from './translate-converse.js';
export { chatCompletionToGemini, geminiStreamBody, geminiToOpenAIChat, geminiUsesIds, type GeminiResponse } from './translate-gemini.js';
export { chatCompletionToResponse, responseEvents, responsesToOpenAIChat, type ResponseObject } from './translate-responses.js';
export { anthropicAnswer, answerAs, CLOUD_ADVICE, CLOUDS, errorAs, isTakeoverCall, modelUnswitchable, requestFor, switchTakeoverModel, takeoverMode, takeoverRefusal, wantsStream, type AnswerOptions, type EncodedAnswer, type TakeoverMode, type TakeoverTarget, type TargetRoute } from './takeover.js';
export { messagesOf, type DatasetMessage } from './dataset.js';
export type { NewPairsExport, PairsExport, TaskScoreRow } from './store.js';
// The decision diff (shadowlap decisions, migrate): a recorded request with only the change swapped
// in, its answer's decision against the recorded one, ranked by consequence; the providers' model
// retirement dates; and the sessions the store keeps.
export { promptOf, promptParts, samePrompt, withoutEarlierThinking, withPrompt, type RequestPrompt } from './prompt.js';
export { DECISIONS_ID, JUDGED_IN_RECORDED_STATE, MIGRATE_ID, NO_TOKENS, RANK_LABELS, STOP_WORDS, argsDelta, bareModel, byConsequence, byRule, callLine, clipText, compareDecisions, controlOpen, decisionLine, decisionOf, decisionOfResponse, decisionView, effectsOf, emptyCounts, estimatedTokens, formatDecisions, hostedToolEffect, isHandover, isReservedScope, judgedOutcome, judgeOpen, majorityRank, modelFamily, promoteByJudge, sameModel, shownSample, stepDelta, unjudgedSample } from './decisions.js';
export type { DecisionCall, DecisionChange, DecisionChangeKind, DecisionComparison, DecisionCounts, DecisionJudge, DecisionJudgeSide, DecisionOptions, DecisionRank, DecisionRemedy, DecisionRun, DecisionStep, DecisionStop, DecisionsChange, DecisionsJudged, DecisionsReport, DecisionsVerify, DecisionView, EffectOf, FromCodeChange, ModelDecision, TokenCount } from './decisions.js';
export { longDate, replacementModels, retiredFields, retirementOf, retirementPlatform, retirementsOf, retirementTable, retirementTableProblems, tableModel } from './model-retirements.js';
export type { FieldRetirement, ModelRetirement, RetirementNotice, RetirementPlatform, RetirementSource, RetirementTable } from './model-retirements.js';
export type { DecisionRunRow, DecisionSessionRow, NewDecisionSession } from './store.js';
// Injection tests: trust, payloads and their canaries, what an attempt wrote, and --clean's neutral
// result (shadowlap injection, and the dashboard's read model of its results).
export { DEFAULT_BASELINES, INJECTION_CHECK, INJECTION_VERDICTS, PAYLOAD_LIMITS, atPath, canaryIn, carriesMark, cleanBound, cleanDecided, cleanRule, configuredTrust, describeIdentifiers, displayPath, fillPayload, findCanary, goneWrites, hasCanary, identifiersOf, injectionTemplates, keepingCanaries, neutralResult, newCanary, normalizedArgs, noVerdicts, parseInjectionEntry, parsePayloads, parseToolTrust, plantMarks, proofLine, selectTemplates, strongestVerdict, templatePayload, trustOf, unexplainedWrites, untrustedReads, writeBaseline, writeRecurs } from './injection.js';
export type { Canary, CanaryForm, CanaryHit, InjectionEntry, InjectionVerdict, Payload, PayloadShape, PayloadTemplate, TemplateSet, ToolTrust, TrustSource, UntrustedRead, VerdictCounts, WriteBaseline, WriteSeen } from './injection.js';
export type { AttemptReport, BaselineReport, CauseVerdict, CellReport, CleanAttemptReport, CleanReport, CleanWriteReport, CostReport, Evidence, GateReport, InjectionReport, Limits, PayloadReport, PlantReport, ReadReport } from './injection.js';
export type { InjectionGateData, StoredInjectionResult } from './store.js';
// Production coverage: imported runs grouped by behaviour (path, writes, outcome), and the goldens that cover each.
export { GROUP_RUN_IDS, GROUP_SOURCES, OUTCOME_WORDS, behaviourKey, behaviourSlug, checkCommandTemplate, commandFinder, describeBehaviour, effectsFor, fillCommand, firstMessage, groupCoverage, hasPlaceholder, inferCommand, nearestGolden, requestMessage, runBehaviour, sharedSteps, storeEffects, strongest } from './coverage.js';
export type { Behaviour, BehaviourOutcome, CoverageGolden, CoverageGroup, CoverageMember, InferredCommand, NearestGolden } from './coverage.js';
export type { CoverageBehaviour, CoverageNotPacked, CoveragePackMode, CoverageScan, CoverageScanData, StoredCoverageGroup, StoredCoveragePack } from './store.js';
// Error-path presets: where each hits a recording and what it answers there.
export { CHAOS_PRESETS, OVERSIZE_CHARS, PRESET_LABELS, chaosTargets, cutJson, isChaosPreset, parsePresets, presetHits, presetReplay, presetResult, resultShape } from './chaos.js';
export type { ChaosPreset, ChaosTarget, ChaosTargets, ResultShape } from './chaos.js';
export type { ChaosResult, ChaosResultData, ChaosSession, ChaosVerdict, NewChaosResult, NewChaosSession } from './store.js';
