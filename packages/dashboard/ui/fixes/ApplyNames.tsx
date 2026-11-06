import { useId, useState } from 'react';
import { goldenNamesProblem, type GoldenNameProblem } from '../../../engine/src/golden-names.js';
import { pressWayOn } from '../components/Dialog.js';
import { quoteArg } from '../jobs.js';
import type { FixDetail } from '../types.js';

/**
 * The names Apply fix gives the goldens it copies (`fix apply --name <run>=<name>`), a field for
 * each under the patch: "The golden from <run>", reading `goldens/` then the name, filled with the
 * one the fix's label makes. Each is checked as it is typed, by the engine's rule, against what the
 * project's goldens folder holds (`goldenNamesProblem`), and Apply fix waits until each will do. The
 * command and the step that says where the recording goes follow what is typed.
 */

type ApplyOffer = NonNullable<FixDetail['actions']['apply']>;

/** The goldens folder the dashboard's apply job copies into, as the fields and the words show it. */
const FOLDER = 'goldens';

export interface GoldenNames {
  /** Each golden apply copies now, by its run, with the name it would take. */
  offered: ApplyOffer['names'];
  /** What each field holds. */
  typed: string[];
  /** Each name as it goes to the job: what was typed, trimmed. */
  names: string[];
  /** Why they won't do yet, about one of them; null once each will. */
  problem: GoldenNameProblem | null;
  set: (at: number, value: string) => void;
}

/** The fields' state, by run: a page read again while the dialog is open keeps what was typed. */
export function useGoldenNames(apply: ApplyOffer): GoldenNames {
  const [given, setGiven] = useState<Record<string, string>>({});
  const typed = apply.names.map((n) => given[n.run] ?? n.name);
  const names = typed.map((t) => t.trim());
  return {
    offered: apply.names,
    typed,
    names,
    problem: apply.names.length ? goldenNamesProblem(names, { folder: FOLDER, held: apply.held ?? [] }) : null,
    set: (at, value) => {
      const run = apply.names[at]?.run;
      if (run) setGiven((now) => ({ ...now, [run]: value }));
    },
  };
}

/** What the job is sent: each golden's name by its run; none when apply copies none now. */
export const nameFields = (g: GoldenNames): Record<string, string> | null => (g.offered.length ? Object.fromEntries(g.offered.map((n, i) => [n.run, g.names[i]!])) : null);

/** `--name <run>=<name>` for each, quoted as the job takes it, with the mock's `<name>` while a field is empty. */
export const nameFlags = (g: GoldenNames): string => g.offered.map((n, i) => ` --name ${g.names[i] ? quoteArg(`${n.run}=${g.names[i]}`) : `${n.run}=<name>`}`).join('');

/** Where the recordings go, as Apply fix's step says it: the one golden's path, or each as named below. */
export const copiedTo = (g: GoldenNames): string | null => (g.offered.length === 1 ? `${FOLDER}/${g.names[0] || '<name>'}` : g.offered.length ? `into ${FOLDER}/, as named below` : null);

/** A field for each golden, and under them why the names won't do yet. */
export function GoldenNameFields({ names }: { names: GoldenNames }) {
  const err = useId();
  if (!names.offered.length) return null;
  const bad = names.problem?.at ?? -1;
  return (
    <>
      <div className="form one gnames">
        {names.offered.map((n, i) => (
          <label key={n.run}>
            <span>
              The golden from <code>{n.run}</code>
            </span>
            <span className="gnin">
              <span>{FOLDER}/</span>
              <input
                type="text"
                value={names.typed[i]}
                spellCheck={false}
                autoComplete="off"
                aria-label={`Name of the golden from ${n.run}`}
                {...(bad === i ? { 'aria-invalid': true, 'aria-describedby': err } : {})}
                onChange={(e) => names.set(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    pressWayOn(e.currentTarget);
                  }
                }}
              />
            </span>
          </label>
        ))}
      </div>
      {names.problem ? (
        <p className="fieldnote err" id={err} role="alert">
          {names.problem.text}
        </p>
      ) : null}
    </>
  );
}
