import { useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { JobButton } from '../components/JobButton.js';
import { shortId } from '../format.js';
import { ACTIONS, confirmWords } from '../labels.js';
import type { UntrustedView } from '../types.js';
import { TestDialogPart } from './test-part.js';

/** A recording a row tests: one of the store's runs, else the golden whose pack holds it, with its reads and its price at the plan nobody picked. */
export interface TestTarget {
  runId: string | null;
  golden: string | null;
  /** The recording's id, for the card's command and the title where `runId` is null; else the golden names it. */
  recording?: string | undefined;
  reads: readonly UntrustedView[];
  estimate: Estimate | null;
}

/**
 * Run injection test… on a row: Settings → Tools' untrusted read, Tests' Security. A form, so a press
 * opens its dialog on every Spending setting, its card saying the amount alone; it asks as the fork
 * menu's does, a command someone else recorded through ConsentDialog.
 */
export function TestButton({ test, sub, className = 'btn sm tooltest' }: { test: TestTarget; sub: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = test.runId || test.recording ? shortId(test.runId ?? test.recording ?? '') : (test.golden ?? '');
  return (
    <>
      <JobButton className={className} form estimate={test.estimate} tip={confirmWords(ACTIONS.runInjectionTest.label)} sub={sub} command={`$ shadowlap injection ${id}`} start={() => setOpen(true)} ask={() => setOpen(true)}>
        {ACTIONS.runInjectionTest.label}
      </JobButton>
      {open ? <TestDialogPart runId={test.runId} golden={test.golden} {...(test.recording ? { recording: test.recording } : {})} reads={test.reads} estimate={test.estimate} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
