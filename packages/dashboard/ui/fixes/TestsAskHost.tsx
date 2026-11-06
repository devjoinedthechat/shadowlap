import { useSyncExternalStore } from 'react';
import { namedIn } from '../components/Id.js';
import { Dialog } from '../components/Dialog.js';
import { useApp } from '../state.js';
import { answerTestsQuestion, liveFacts, onTestsQuestion, testsQuestion } from '../tests-ask.js';
import { AskNote } from '../components/AskNote.js';

/**
 * The question a Tests job waits on before it runs anything live (tests-ask.ts), wherever it was
 * started: Tests' buttons, a test replay's banner, the palette. The server lists the goldens that go
 * live and why, the commands the job runs follow, its Cost line says the estimate where the page knew
 * it, its footer why it asks where the threshold is why, and only its button sends the yes. It
 * opens on that button, as the other asks before a job that bills do (Run repair, Update
 * golden, Find breaking commit): Cancel takes the focus first only where a dialog deletes or stops
 * something, or runs a command someone else recorded (ConsentDialog). The shell draws it once, over
 * every page. It also asks before a billed job with no 409 behind it, where Spending says it asks
 * and no page of its own is open to (the palette's Run blame on another run): its button runs the
 * question's `start`.
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
      // The session's estimate where its page knew it, else what the server's words say.
      cost={{ price: 'Billed by your provider', parts: q.parts ?? [], estimate: q.estimate }}
      footNote={<AskNote estimate={q.estimate} />}
      ok={q.ok}
      onOk={() => answerTestsQuestion(app, true)}
      onClose={() => answerTestsQuestion(app, false)}
    />
  );
}
