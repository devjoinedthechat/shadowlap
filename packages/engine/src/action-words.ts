/**
 * One name for each action, as every place that offers it says it: the dashboard's button, menu item
 * and ⌘K entry, its dialog's title and confirm, and the terminal UI's line (`label`); and, for one that
 * runs as a job, its title while it runs, in the -ing form its drawer heads it with (`doing`). A toast
 * says it in the past tense once it ends (the dashboard's ui/labels.ts). Labels are verb and object,
 * in sentence case with no articles, in the CLI's verb where it has one ("Run <command>" where the
 * bare command reads wrong); an ellipsis means the action asks for something before it runs, and its
 * dialog's title and confirm are the label without it. Share's items are the copies they make, as
 * parallel nouns. No imports: the dashboard's pages bundle it as it is, and its server titles each
 * job from it.
 */

export interface ActionWords {
  /** Its name wherever it is offered. */
  label: string;
  /** Its job's title while it runs (`Repairing`, `Finding breaking commit`), for one that runs as a job. */
  doing?: string;
}

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
  // The fork menu's whole run, and what has a place of its own (the header's Replay, Share's Pack).
  repeat: { label: 'Repeat 5 times…', doing: 'Repeating' },
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
  applyFix: { label: 'Apply fix', doing: 'Applying fix' },
  // Tests.
  runTests: { label: 'Run tests', doing: 'Running tests' },
  updateGolden: { label: 'Update golden', doing: 'Updating golden' },
  updateGoldens: { label: 'Update goldens…', doing: 'Updating goldens' },
  addNormalizer: { label: 'Add normalizer', doing: 'Adding normalizer' },
  addNormalizerAndUpdate: { label: 'Add normalizer and update', doing: 'Adding normalizer and updating golden' },
  findBreakingCommit: { label: 'Find breaking commit…', doing: 'Finding breaking commit' },
  // Runs and Training.
  // A trace from a store too: Activity says what it was.
  importCapture: { label: 'Import capture…', doing: 'Importing capture' },
  exportPairs: { label: 'Export pairs…', doing: 'Exporting pairs' },
  scoreModel: { label: 'Score model…', doing: 'Scoring model' },
  // Share, each item the copy it makes.
  exportHtml: { label: 'HTML report', doing: 'Exporting HTML report' },
  pack: { label: 'Pack…', doing: 'Packing' },
  exportDataset: { label: 'Eval dataset…', doing: 'Exporting dataset' },
  // To a file or a collector alike.
  exportTrace: { label: 'OpenTelemetry trace…', doing: 'Exporting trace' },
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
