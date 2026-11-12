import { messageOf } from '../../../engine/src/message-of.js';
import { ActionButton } from '../components/ActionButton.js';
import { ACTIONS } from '../labels.js';
import { useApp } from '../state.js';
import type { FoundChange } from '../types.js';
import { editorOpened, editorSub, editorTarget } from './editor.js';

/**
 * Open in editor: the change's file at the line it added, opened by the server in the editor $VISUAL
 * or $EDITOR names (`POST /api/editor/open`), its toast saying so, or the server's words where it
 * can't. Its card's `$` line is what the server runs (meta's `editor`). None where this machine opens
 * no editor, in a copy, or for a file outside the project; off with why on a read-only dashboard, as
 * every write is. `fold`: the run header's slot it folds into … by.
 */
export function EditorButton({ change, className = 'btn', fold }: { change: Pick<FoundChange, 'path' | 'line'> | null | undefined; className?: string; fold?: string }) {
  const { meta, exported, client, toast } = useApp();
  const t = exported ? null : editorTarget(change, meta?.editor);
  if (!t) return null;
  const open = () => client.editor.open(t.path, t.line).then((o) => toast(editorOpened(o)), (err: unknown) => toast(messageOf(err)));
  const { label } = ACTIONS.openInEditor;
  return (
    <ActionButton className={className} tip={label} sub={editorSub(t)} command={`$ ${t.cmd}`} {...(fold ? { 'data-fold': fold } : {})} onClick={() => void open()}>
      {label}
    </ActionButton>
  );
}
