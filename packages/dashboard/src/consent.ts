import { createHash } from 'node:crypto';

/**
 * A yes to a command someone else's run brings (a pack's, a teammate's pulled from the team store,
 * one a program sent the sidecar) is a yes to the command lines the question showed, never to
 * whatever a second request builds. The question, a 409, carries `confirm`: a digest of those lines.
 * A request says yes by sending it back (`yes`, or `confirmed` for the error-path presets). The
 * server builds the request's command again, so one that would now run another line (a pull
 * changed the fields a blame is made from, the run is another) is asked again, naming that line.
 */
export function consentKey(lines: ReadonlyArray<readonly string[]>): string {
  return createHash('sha256').update(JSON.stringify(lines)).digest('hex').slice(0, 32);
}

/** Whether `yes` is the `confirm` of the question that showed `lines`. */
export function saidYes(yes: unknown, lines: ReadonlyArray<readonly string[]>): boolean {
  return typeof yes === 'string' && yes === consentKey(lines);
}

/** The question: the words it shows, and what saying yes to them sends back. */
export function askConsent(error: string, lines: ReadonlyArray<readonly string[]>): { error: string; status: 409; confirm: string } {
  return { error, status: 409, confirm: consentKey(lines) };
}

/**
 * A job's question about the commands someone else chose that it runs (`lines`), or its answer:
 * `ask`, the 409 in the words `words` gives, until the request says yes to exactly those lines; then
 * `yes`, the `--yes` the CLI takes so it asks nothing again. With nothing to ask, `yes` is empty: a
 * yes a request sends anyway answers no question, so it never reaches the CLI, which asks what it
 * asks itself (and refuses it, as a job has no terminal to answer in).
 */
export type JobConsent = { ask: { error: string; status: 409; confirm: string } } | { yes: string[] };

export function jobConsent(lines: ReadonlyArray<readonly string[]>, yes: unknown, words: () => string): JobConsent {
  if (!lines.length) return { yes: [] };
  return saidYes(yes, lines) ? { yes: ['--yes'] } : { ask: askConsent(words(), lines) };
}
