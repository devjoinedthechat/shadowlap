import { CodeBox } from '../components/CodeBox.js';
import { patchLines } from '../fixes/model.js';

/** A patch drawn as Apply fix draws one: a change's box, each line marked and in its colour, a stop for the keys, since a dialog scrolls it. */
export function Patch({ text }: { text: string }) {
  return <CodeBox lines={patchLines(text)} className="fxpatch" />;
}
