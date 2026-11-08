import { Dialog } from '../components/Dialog.js';
import { shortId } from '../format.js';
import type { BuilderProps } from '../run/check-part.js';

/**
 * The check builder: a check made from a run's tool call, judged on the agent's recordings as it is
 * built, and saved to a golden's `tests` entry in shadowlap.config.json. A part of its own, which a
 * run's page loads the first time its check menu opens (run/check-entry.tsx).
 */
export function Builder({ run, call, onClose }: BuilderProps) {
  const c = call.call;
  const lead = (
    <>
      Makes a check from #{c.callNo} <code>{c.name}</code> in <code>{shortId(run.run.runId)}</code>, judged on your recordings as you build it.
    </>
  );
  return <Dialog title="Add check" lead={lead} className="ckb" onClose={onClose} />;
}
