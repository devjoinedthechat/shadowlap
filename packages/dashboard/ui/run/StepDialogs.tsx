import type { ComponentProps } from 'react';
import type { RunOffers } from '../api.js';
import { ConfirmDialog, ConsentDialog, PromptDialog, type WayOn } from '../components/Dialog.js';
import { namedIn } from '../components/Id.js';
import { goldenName, shortId } from '../format.js';
import { ACTIONS, confirmWords } from '../labels.js';
import type { NextStep } from '../types.js';
import { stepCostLine } from './next-step.js';
import { PACK_HOLDS, packTestCommands, redactsFact } from './share-facts.js';
import '../injection/job-footer.js';

/*
 * The dialogs the run page's steps ask in, Pack as golden…'s too (Run injection test…'s and Pack with injection gate…'s are their own, injection/): rarely opened, so a part of their
 * own, which only the served dashboard hands in (served-parts.ts, from pages/served.tsx). A copy's
 * run page draws no step that asks, so its script holds none of them (test/ui-exported-copy.test.ts). The buttons stay where they show (NextStepButton.tsx, PackAsGolden.tsx), and so does what
 * each answer runs, so a dialog closed, or a consent asked after it, reads as it did.
 */

type Step<K extends NextStep['key']> = Extract<NextStep, { key: K }>;
type Run = ComponentProps<typeof PromptDialog>['onRun'];

/** What a step asks, with what its answer runs. */
export type StepAsk =
  | { kind: 'update'; step: Step<'normalizer' | 'update-golden'>; onOk: WayOn }
  | { kind: 'injection'; step: Step<'injection-again'>; onOk: WayOn }
  | { kind: 'pack'; runId: string; dir: string; refused: string | null; offers: RunOffers | null; onRun: Run }
  | { kind: 'consent'; why: string; ok: string; onOk: WayOn };

export interface StepDialogProps {
  ask: StepAsk;
  onClose: () => void;
}

const CHANGES = { label: 'Changes', value: 'your working tree', quiet: 'the golden’s folder' };
const packRules = (offers: RunOffers | null) => redactsFact(offers?.copies.formats.find((f) => f.id === 'pack')?.rules ?? null);

export function StepDialog({ ask, onClose }: StepDialogProps) {
  switch (ask.kind) {
    case 'update': {
      const { step } = ask;
      return (
        <ConfirmDialog
          title={`Update ${goldenName(step.golden)}?`}
          lead={step.sub ? `${step.sub}.` : `Re-records ${goldenName(step.golden)}, for a change you meant.`}
          doc="goldenUpdates"
          command={step.command ?? null}
          cost={stepCostLine(step)}
          ok={step.label}
          onClose={onClose}
          onOk={ask.onOk}
        />
      );
    }
    case 'injection': {
      const { step } = ask;
      const id = shortId(step.runId);
      return (
        <ConfirmDialog
          title={namedIn(`${confirmWords(step.label)} on ${id}`, id)}
          lead="Plants the same payloads in the same reads again."
          doc="injectionTests"
          warn={step.sub ? { text: step.sub } : null}
          command={step.command ?? null}
          cost={stepCostLine(step)}
          ok={confirmWords(step.label)}
          onClose={onClose}
          onOk={ask.onOk}
        />
      );
    }
    case 'pack': {
      const id = shortId(ask.runId);
      return (
        <PromptDialog
          title={namedIn(`Pack ${id} as golden?`, id)}
          lead="Packs the run into goldens/ and tests it, for shadowlap test to replay on every commit."
          doc="makeGolden"
          {...(ask.refused ? { warn: { text: ask.refused, written: true } } : {})}
          facts={[CHANGES, PACK_HOLDS, packRules(ask.offers)]}
          label="Golden"
          initial={ask.dir}
          command={(dir) => ({ command: packTestCommands(ask.runId, dir) })}
          ok={confirmWords(ACTIONS.packAsGolden.label)}
          onClose={onClose}
          onRun={ask.onRun}
        />
      );
    }
    case 'consent':
      return <ConsentDialog why={ask.why} ok={ask.ok} onClose={onClose} onOk={ask.onOk} />;
  }
}
