/**
 * A golden's error-path presets, as `"chaos"` in its `tests` entry says them, read as the engine reads
 * them (engine/src/checks/tests-entry.ts), beside the rest of the entry.
 */

export { CHAOS_TIMEOUT, DEFAULT_CHAOS, chaosFor, parseChaosFields } from '@shadowlap/engine';
export type { ChaosSpec, ExpectParser } from '@shadowlap/engine';
