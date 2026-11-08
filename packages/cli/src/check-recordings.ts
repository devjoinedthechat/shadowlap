/**
 * `shadowlap check`: recordings judged by checks from what they recorded, with nothing replayed and
 * no tokens spent (the engine's checks/recordings.ts, which the dashboard's check builder judges
 * with too, so the two say the same), and the recording a pack holds, read into a store of its own.
 */
import { packRecording as unpackRecording, type RunRecord, type Store } from '@shadowlap/engine';
import { readPackHead } from './goldens.js';

export { BUG_LABEL, checkRecordings } from '@shadowlap/engine';

/**
 * The recording a pack holds, read into a store of its own. A folder that is no pack is refused in
 * readPackHead's words before anything is unpacked, as `shadowlap check` has always said it.
 */
export function packRecording(dir: string): { run: RunRecord; store: Store } {
  const head = readPackHead(dir);
  if ('error' in head) throw new Error(`${dir}: ${head.error}`);
  return unpackRecording(dir);
}
export type { CheckReport, CheckedRecording, RecordingToCheck } from '@shadowlap/engine';
