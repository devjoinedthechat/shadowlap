// The actions palette and the dashboard's fork menu are the engine's (run-actions.ts), which the
// dashboard reads without the terminal UI; @shadowlap/tui/actions names them for the terminal UI.
export { actionContext, actionMissing, bisectAction, buildActions, CAPTURE_NOTE, forkArgs, forkCommand, forkMenuTitle, isUserInput, notRun, PLANTED_INSTRUCTIONS, recordingNow, splitCommand, terminalActions, type Action, type ActionContext } from '@shadowlap/engine';
