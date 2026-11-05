import { useSyncExternalStore, type ReactNode } from 'react';
import { CmdLine } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { useApp } from '../state.js';
import { answerTestsQuestion, onTestsQuestion, testsQuestion } from '../tests-ask.js';
import { useTestsWait } from './tree.js';

/**
 * A button that starts a Tests job from another page (Add normalizer and Update golden on a test
 * replay's page): disabled, with the reason on hover, while the server would refuse it, as the Tests
 * page's own buttons are. `off` is the page's reason first (a read-only dashboard); `title` is the
 * hover while it can start, or `tip`, a hover card. `lead`: it is the run's next step, which the
 * palette presses by that name. A job that would run goldens live asks first (TestsAskHost).
 */
export function TestsJobButton({ verb, off, title, tip, lead, className, onClick, children }: { verb: string; off: string | null; title?: string | null; tip?: string; lead?: string; className: string; onClick: () => void; children: ReactNode }) {
  const wait = useTestsWait(verb);
  const why = off ?? wait;
  return (
    <button className={className} type="button" disabled={!!why} title={why ?? title ?? undefined} {...(tip && !why ? { 'data-tip': tip } : {})} {...(lead ? { 'data-next': lead } : {})} onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * The question a Tests job waits on before it runs anything live (tests-ask.ts), wherever it was
 * started: Tests' buttons, a test replay's banner, the palette. The server's words name the goldens
 * that go live and why, the commands the job runs follow, and only its button sends the yes. It
 * opens on that button, as the other asks before a job that bills do (Run repair, Update
 * golden, Find breaking commit): Cancel takes the focus first only where a dialog deletes or stops
 * something, or runs a command someone else recorded (ConsentDialog). The shell draws it once, over
 * every page.
 */
export function TestsAskHost() {
  const app = useApp();
  const q = useSyncExternalStore(onTestsQuestion, testsQuestion);
  if (!q) return null;
  return (
    <Dialog title={q.title} text={`${q.why}.`} ok={q.ok} onOk={() => answerTestsQuestion(app, true)} onClose={() => answerTestsQuestion(app, false)}>
      {q.commands?.length ? q.commands.map((c, i) => <CmdLine key={`${i}:${c}`}>{c}</CmdLine>) : null}
    </Dialog>
  );
}
