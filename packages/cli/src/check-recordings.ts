/**
 * `shadowlap check`: recordings judged by checks from what they recorded, with nothing replayed and
 * no tokens spent (the engine's checks/recordings.ts, which the dashboard's check builder judges
 * with too, so the two say the same), and the recording a pack holds, read into a store of its own.
 */
export { BUG_LABEL, checkRecordings, packRecording } from '@shadowlap/engine';
export type { CheckReport, CheckedRecording, RecordingToCheck } from '@shadowlap/engine';
