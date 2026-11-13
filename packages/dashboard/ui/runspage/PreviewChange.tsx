import { tooManyToPreview } from '../../src/decisions-argv.js';
import { NewPreviewMenu } from '../components/NewPreviewMenu.js';
import { shortId } from '../format.js';
import { ACTIONS, BULK } from '../labels.js';

/** How many runs Preview change's card names before it cuts the rest to `…`. */
const NAMED = 3;

/**
 * Runs' Preview change: New preview's menu on the runs picked that ended, as a preview asks the
 * calls a recording holds. It waits while every run picked is still recording, and past the 500
 * runs one preview takes, in the job's own words.
 */
export function PreviewChange({ picked, ended }: { picked: readonly string[]; ended: readonly string[] }) {
  const named = ended.length ? ended : picked;
  const command = `$ shadowlap decisions ${named.slice(0, NAMED).map(shortId).join(' ')}${named.length > NAMED ? ' …' : ''} --model <model>`;
  const waits = ended.length ? tooManyToPreview(ended.length) : BULK.waits(picked.length);
  return <NewPreviewMenu target={{ runs: ended }} small why={waits} bulk={{ label: ACTIONS.previewChange.label, tip: 'Preview change on runs picked', whyTip: ended.length ? undefined : BULK.previewWaitsTip(picked.length), command }} />;
}
