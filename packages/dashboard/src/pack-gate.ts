import { CONFIG_FILE, ConfigBusyError, ConfigConflictError, editWhenFree, isObject, messageOf, parseInjectionEntry, readConfigFile } from '@shadowlap/engine';
import type { RouteContext } from './context.js';
import { changedOnDisk, GATE_KEYS, printsOf, writeTestsEntry, type ConfigPrints } from './config-tests.js';
import type { JobStep, StepDone } from './job-step.js';
import { log, VERSION } from './routes/settings-edits.js';

/**
 * Pack with injection gate…: a `pack-test` job that, once the run is packed, writes the golden's
 * gate into its tests entry (`tests["<golden>"].injection`) against the version of
 * shadowlap.config.json the page read, then tests it. The write is the check builder's
 * (writeTestsEntry), setting `injection` alone; the whole of `tests` is checked as `shadowlap test`
 * checks it. A write refused (the file changed since, or the gate is not one) ends the job there, in
 * its words: the golden stays packed without its gate, and no test runs.
 */

/** The gate the dialog sends: `{ obeyed: 0, repeat, templates? }`, templates only when not all. */
export interface PackGate {
  obeyed: 0;
  repeat: number;
  templates?: string[];
}

/** What a request asks of the gate: its gate, the version read and the prints of what it read; null without one. */
export interface GateAsk {
  gate: PackGate;
  version: string;
  read: ConfigPrints | null;
}

/** The request's gate, checked as a tests entry's `injection` is (parseInjectionEntry), or why not. */
export function gateAsk(req: Record<string, unknown>): GateAsk | null | { error: string } {
  if (req.gate === undefined) return null;
  const raw = req.gate;
  if (!isObject(raw) || (raw.obeyed !== undefined && raw.obeyed !== 0)) return { error: 'gate is { "obeyed": 0, "repeat": <attempts each>, "templates"?: [<ids>] }' };
  const gate: PackGate = { obeyed: 0, repeat: typeof raw.repeat === 'number' ? raw.repeat : Number.NaN, ...(raw.templates === undefined ? {} : { templates: raw.templates as string[] }) };
  try {
    parseInjectionEntry(gate, 'gate');
  } catch (err) {
    return { error: messageOf(err) };
  }
  if (typeof req.version !== 'string' || !VERSION.test(req.version)) return { error: `version is the version of ${CONFIG_FILE} the page read: open the dialog again and try again` };
  return { gate, version: req.version, read: printsOf(req.read) };
}

/** A gate as the line that says it was added shows it: `{ "obeyed": 0, "repeat": 3 }`. */
export function gateText(gate: PackGate): string {
  return `{ ${Object.entries(gate)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(', ')} }`;
}

/** Why the write was refused, from the file as it is now when it changed since the page read it. */
function refusal(dir: string, read: ConfigPrints | null, err: unknown): string {
  if (err instanceof ConfigConflictError && !(err instanceof ConfigBusyError)) {
    try {
      return changedOnDisk(read, readConfigFile(dir));
    } catch {
      return messageOf(err);
    }
  }
  return messageOf(err);
}

/**
 * The step that writes the gate, before the command at `before`: `  added to shadowlap.config.json,
 * under "tests": "goldens/x": { "injection": { "obeyed": 0, "repeat": 3 } }`, recorded in the
 * activity feed; refused, the golden packed without its gate and why, ending the job with exit 1.
 */
export function gateStep(ctx: RouteContext, dir: string, golden: string, ask: GateAsk, before: number): JobStep {
  return {
    before,
    run: async (): Promise<StepDone> => {
      try {
        const written = await editWhenFree((o) => writeTestsEntry(dir, golden, { injection: ask.gate }, { ...o, expect: ask.version, keys: GATE_KEYS }));
        log(ctx, written.event ? [written.event] : [], dir);
        return { lines: [`  added to ${CONFIG_FILE}, under "tests": ${JSON.stringify(written.key)}: { "injection": ${gateText(ask.gate)} }`] };
      } catch (err) {
        return { lines: [`${golden} is packed without its gate: ${refusal(dir, ask.read, err)}`], code: 1 };
      }
    },
  };
}
