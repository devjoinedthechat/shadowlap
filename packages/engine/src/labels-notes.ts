/**
 * Labels and notes: what people know about a run that the recording can't. A label says what the run
 * is (`bug`, `good`, `refund-flow`), so runs can be found, listed and exported as a dataset by it; a
 * note says why, on the run or on one call.
 */
import type { RunNote } from './types.js';

export const LABEL_MAX = 40;
export const LABELS_PER_RUN = 50;
export const NOTE_MAX = 10_000;
export const NOTES_PER_RUN = 1000;

const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} _.:/-]*$/u;

/** A label as stored, or an error message explaining what is wrong with it. */
export function cleanLabel(raw: string): { label: string } | { error: string } {
  const label = raw.trim().replace(/\s+/g, ' ');
  if (!label) return { error: 'a label cannot be empty' };
  if (label.length > LABEL_MAX) return { error: `a label is at most ${LABEL_MAX} characters: ${label.slice(0, LABEL_MAX)}…` };
  if (!LABEL.test(label)) return { error: `a label starts with a letter or digit and uses letters, digits, spaces and _ . : / -: ${label}` };
  return { label };
}

export function withLabels(current: readonly string[] | undefined, add: readonly string[], remove: readonly string[] = []): string[] {
  const out = (current ?? []).filter((l) => !remove.includes(l));
  for (const l of add) if (!out.includes(l)) out.push(l);
  if (out.length > LABELS_PER_RUN) throw new Error(`a run has at most ${LABELS_PER_RUN} labels`);
  return out;
}

export function withNote(current: readonly RunNote[] | undefined, note: RunNote): RunNote[] {
  const text = note.text.trim();
  if (!text) throw new Error('a note cannot be empty');
  if (text.length > NOTE_MAX) throw new Error(`a note is at most ${NOTE_MAX} characters`);
  const out = [...(current ?? []), { ...note, text }];
  if (out.length > NOTES_PER_RUN) throw new Error(`a run has at most ${NOTES_PER_RUN} notes`);
  return out;
}
