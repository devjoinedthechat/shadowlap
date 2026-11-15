import { useId, useState } from 'react';

/**
 * Stop at $, on the asks of a fix's billed jobs (blame, repair, verify), as on an injection test's:
 * no attempt starts once that much is spent on live model calls (`--budget`). It starts at the budget
 * the step's command keeps, else empty, for none; what it holds goes with the job, which runs the
 * command with that budget, or with none.
 */

/** The amount typed, to the cent, or null for none: an empty field, or one that is no amount above 0. */
export function stopAtValue(typed: string): number | null {
  const usd = Number(typed);
  return typed.trim() && Number.isFinite(usd) && usd > 0 ? Math.round(usd * 100) / 100 : null;
}

/** A command as its job runs it with Stop at $: `--budget` with the amount, in place of one it kept, before a command of the agent's own after ` -- `. */
export function commandWithBudget(command: string, usd: number | null): string {
  const cut = command.indexOf(' -- ');
  const head = (cut < 0 ? command : command.slice(0, cut)).replace(/ --budget \S+/, '');
  return `${head}${usd === null ? '' : ` --budget ${usd.toFixed(2)}`}${cut < 0 ? '' : command.slice(cut)}`;
}

/**
 * The field and what it holds: the fields its job starts with (`budget`, the amount or null for none)
 * and the command with it. Left as it opened, it sends nothing, and the command runs as it was made,
 * a budget it kept as written.
 */
export function useStopAt(kept: string | null | undefined): { typed: string; setTyped: (v: string) => void; fields: { budget?: number | null }; command: (c: string) => string } {
  const [typed, setTypedAs] = useState(kept ?? '');
  const [touched, setTouched] = useState(false);
  const budget = stopAtValue(typed);
  const setTyped = (v: string) => {
    setTouched(true);
    setTypedAs(v);
  };
  return { typed, setTyped, fields: touched ? { budget } : {}, command: (c) => (touched ? commandWithBudget(c, budget) : c) };
}

/** The field, labelled as the injection test's is: placeholder `none`, in steps of 50 cents. */
export function StopAtField({ typed, setTyped }: { typed: string; setTyped: (v: string) => void }) {
  const id = useId();
  return (
    <div className="fxstop">
      <label htmlFor={id}>Stop at $</label>
      <input id={id} type="number" min={0.5} step={0.5} placeholder="none" value={typed} onChange={(e) => setTyped(e.target.value)} />
    </div>
  );
}
