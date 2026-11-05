import { useSyncExternalStore, type ReactNode } from 'react';
import { namedIn } from '../components/Id.js';
import { Dialog } from '../components/Dialog.js';
import { useApp } from '../state.js';
import { answerTestsQuestion, liveFacts, onTestsQuestion, testsQuestion } from '../tests-ask.js';
import { useTestsWait } from './tree.js';

/**
 * A button that starts a Tests job from another page (Add normalizer and Update golden on a test
 * replay's page): disabled, with the reason on hover, while the server would refuse it, as the Tests
 * page's own buttons are. `off` is the page's reason first (a read-only dashboard); `title` is the
 * hover while it can start. A job that would run goldens live asks first (TestsAskHost).
 */
export function TestsJobButton({ verb, off, title, className, onClick, children }: { verb: string; off: string | null; title?: string | null; className: string; onClick: () => void; children: ReactNode }) {
  const wait = useTestsWait(verb);
  const why = off ?? wait;
  return (
    <button className={className} type="button" disabled={!!why} title={why ?? title ?? undefined} onClick={onClick}>
      {children}
    </button>
  );
}

/**
 * The question a Tests job waits on before it runs anything live (tests-ask.ts), wherever it was
 * started: Tests' buttons, a test replay's banner, the palette. The server lists the goldens that go
 * live and why, the commands the job runs follow, and only its button sends the yes. It
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
    <Dialog
      title={q.name ? namedIn(q.title, q.name) : q.title}
      lead={q.lead}
      doc={q.doc}
      // A question with rows of its own keeps to them (Run more attempts: its limit, and how soon it
      // settles); else the goldens that go live, or without the server's list, its sentence.
      facts={q.facts ?? (q.live ? liveFacts(q.live) : [{ label: 'Runs live', value: q.why }])}
      command={q.commands?.length ? { command: q.commands } : null}
      cost={{ price: 'Billed by your provider', parts: q.parts ?? [] }}
      ok={q.ok}
      onOk={() => answerTestsQuestion(app, true)}
      onClose={() => answerTestsQuestion(app, false)}
    />
  );
}
