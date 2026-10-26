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
