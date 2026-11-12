/**
 * One name for each action, as every place that offers it says it: the dashboard's button, menu item
 * and ⌘K entry, its dialog's title and confirm, and the terminal UI's line (`label`); and, for one that
 * runs as a job, its title while it runs, in the -ing form its drawer heads it with (`doing`). A toast
 * says it in the past tense once it ends (the dashboard's ui/labels.ts). Labels are verb and object,
 * in sentence case with no articles, in the CLI's verb where it has one ("Run <command>" where the
 * bare command reads wrong); an ellipsis means the action asks for something before it runs, and its
 * dialog's title and confirm are the label without it, but where `title` or `confirm` says otherwise.
 * Share's items are the copies they make, as parallel nouns, so their dialogs say the verb. No
 * imports: the dashboard's pages bundle it as it is, and its server titles each job from it.
 */

export interface ActionWords {
  /** Its name wherever it is offered. */
  label: string;
  /**
   * Its dialog's title, where that is more than the label without its ellipsis: the verb for a Share
   * item (`Export OpenTelemetry trace`), what a fork's Repeat 5 times repeats (`Repeat fork 5 times`).
   */
  title?: string;
  /** Its dialog's confirm, where that is not the label without its ellipsis: `Export trace`, `Pack run`. */
  confirm?: string;
  /** Its job's title while it runs (`Repairing`, `Finding breaking commit`), for one that runs as a job. */
  doing?: string;
}

/** The model Run blame with stronger model's field suggests before one is typed, and so the model its price is worked out at until one is. */
export const STRONGER_MODEL = 'claude-opus-5-5';

export const ACTIONS = {
  // The fork menu at a call, in the CLI's verbs, as the terminal UI and the dashboard offer it
  // (run-actions.ts); Force <tool> live names its tool.
  injectInstruction: { label: 'Inject instruction…', doing: 'Forking' },
  switchModel: { label: 'Switch model from here…', doing: 'Forking' },
  useChangedPrompt: { label: 'Use changed prompt from here', doing: 'Forking' },
  failWithStatus: { label: 'Fail with HTTP status…', doing: 'Forking' },
  overrideResult: { label: 'Override result…', doing: 'Forking' },
  failWithToolError: { label: 'Fail with tool error…', doing: 'Forking' },
  plantInstruction: { label: 'Plant instruction…', doing: 'Planting instruction' },
  overrideUserReply: { label: 'Override user reply…', doing: 'Forking' },
  runLive: { label: 'Run live from here', doing: 'Forking' },
  // The fork menu's whole run, and what has a place of its own (the header's Replay, Share's Pack). A
  // fork's Repeat 5 times asks first, as its attempts run live from the fork: a recording's replays free.
  repeat: { label: 'Repeat 5 times', title: 'Repeat fork 5 times', doing: 'Repeating' },
  replayStubbed: { label: 'Replay with writes stubbed', doing: 'Replaying' },
  replay: { label: 'Replay', doing: 'Replaying' },
  replayWithCommand: { label: 'Replay with your command…', doing: 'Replaying' },
  packRun: { label: 'Pack run…', doing: 'Packing' },
  findChangingCommit: { label: 'Find commit that changed it…', doing: 'Finding commit that changed it' },
  // Fixes: blame, repair, verify and apply.
  runBlame: { label: 'Run blame', doing: 'Blaming' },
  runBlameAgain: { label: 'Run blame again', doing: 'Blaming again' },
  // Its dialog asks which model, so it ends in an ellipsis; the model is in the command, not the title.
  runBlameStronger: { label: 'Run blame with stronger model…', doing: 'Blaming with stronger model' },
  runRepair: { label: 'Run repair', doing: 'Repairing' },
  runVerify: { label: 'Run verify', doing: 'Verifying' },
  runMoreAttempts: { label: 'Run more attempts', doing: 'Running more attempts' },
  verifyAgain: { label: 'Verify again', doing: 'Verifying again' },
  // A verified fix's failing runs that no accepted verify checked, verified on the code as it is now.
  verifyThisRun: { label: 'Verify this run', doing: 'Verifying' },
  verifyTheseRuns: { label: 'Verify these runs', doing: 'Verifying' },
  applyFix: { label: 'Apply fix', doing: 'Applying fix' },
  // A migration's config change, put in the working tree as `shadowlap migrate apply` puts it.
  applyConfigChange: { label: 'Apply config change', doing: 'Applying config change' },
  // Changes: a preview of a change, from Preview, a run's Decisions view, Runs and the palette. A
  // menu's opener and Open preview ask nothing; a way that asks for its model or its field does.
  newPreview: { label: 'New preview' },
  previewChange: { label: 'Preview change' },
  previewModelSwitch: { label: 'Preview model switch…', doing: 'Previewing model switch' },
  previewChangedPrompt: { label: 'Preview changed prompt', doing: 'Previewing changed prompt' },
  previewFieldChange: { label: 'Preview field change…', doing: 'Previewing field change' },
  openPreview: { label: 'Open preview' },
  openMigrationReport: { label: 'Open migration report' },
  // Tests.
  runTests: { label: 'Run tests', doing: 'Running tests' },
  updateGolden: { label: 'Update golden', doing: 'Updating golden' },
  updateGoldens: { label: 'Update goldens', doing: 'Updating goldens' },
  // A normalizer a divergence or Calibrate proposes is added at once; with the golden's test after
  // it, re-run or updated when the rule alone can't make the replay match (a dialog that only
  // confirms earns no ellipsis). One of your own asks for its rule (Settings → Matching).
  addNormalizer: { label: 'Add normalizer', doing: 'Adding normalizer' },
  addNormalizerAndRerun: { label: 'Add normalizer and re-run', doing: 'Adding normalizer and re-running' },
  addNormalizerAndUpdate: { label: 'Add normalizer and update', doing: 'Adding normalizer and updating golden' },
  addNormalizerRule: { label: 'Add normalizer…' },
  findBreakingCommit: { label: 'Find breaking commit…', doing: 'Finding breaking commit' },
  // What a run's page leads with besides those: a page to open, a test run again, a pack made a golden.
  openFix: { label: 'Open fix' },
  // A repair's way on, by what it left: the change it accepted, or the candidates it tried and why each was dropped.
  openChange: { label: 'Open change' },
  openCandidates: { label: 'Open candidates' },
  openProof: { label: 'Open proof' },
  openPassingRun: { label: 'Open passing run' },
  compareWithParent: { label: 'Compare with parent' },
  compareWithFork: { label: 'Compare with fork' },
  compareWithReplay: { label: 'Compare with replay' },
  compare: { label: 'Compare' },
  replayRecording: { label: 'Replay recording', doing: 'Replaying' },
  rerunTest: { label: 'Re-run test', doing: 'Re-running test' },
  runInjectionTest: { label: 'Run injection test…', doing: 'Testing for injection' },
  rerunInjectionTest: { label: 'Re-run injection test', doing: 'Testing for injection' },
  packAsGolden: { label: 'Pack as golden…', doing: 'Packing as golden' },
  packWithGate: { label: 'Pack with injection gate…', doing: 'Packing with injection gate' },
  // Runs and Training. Import capture… takes a trace from a store too, which Activity names.
  importCapture: { label: 'Import capture…', doing: 'Importing capture' },
  exportPairs: { label: 'Export pairs…', doing: 'Exporting pairs' },
  scoreModel: { label: 'Score model…', doing: 'Scoring model' },
  // Share, each item the copy it makes, its dialog the verb; a dataset's names the runs it copies.
  exportHtml: { label: 'HTML report', doing: 'Exporting HTML report' },
  pack: { label: 'Pack…', confirm: 'Pack run', doing: 'Packing' },
  exportDataset: { label: 'Eval dataset…', title: 'Export eval dataset', confirm: 'Export dataset', doing: 'Exporting dataset' },
  // To a file or a collector alike.
  exportTrace: { label: 'OpenTelemetry trace…', title: 'Export OpenTelemetry trace', confirm: 'Export trace', doing: 'Exporting trace' },
  exportHar: { label: 'HAR file', doing: 'Exporting HAR file' },
  // Settings and the palette.
  calibrate: { label: 'Calibrate', doing: 'Calibrating' },
  addRedactionRule: { label: 'Add redaction rule…', doing: 'Adding redaction rule' },
  addProject: { label: 'Add project…' },
  setUpTeamStore: { label: 'Set up team store' },
  continueTeamStoreSetup: { label: 'Continue team store setup' },
  keyboardShortcuts: { label: 'Keyboard shortcuts' },
} as const satisfies Record<string, ActionWords>;

/** Force <tool> live, at a tool call of the fork menu. */
export const forceLiveLabel = (tool: string): string => `Force ${tool} live`;

/** A dialog's title or confirm for an action that asks first: its label without the ellipsis. */
export const confirmWords = (label: string): string => label.replace(/…$/, '');
