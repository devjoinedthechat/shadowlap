import { CodeBox, CopyButton } from '../components/CodeBox.js';
import type { FoundChange } from '../types.js';
import { EditorButton } from './EditorButton.js';
import { changeLines, COPY_REVERT_SUB, gitRevertCommand } from './model.js';

/**
 * The first bad commit's change in its file's box: the file named in its header, Open in editor and
 * Copy git revert at its right as one group, the hunk under it, each line it added or removed marked.
 * Copy git revert copies the revert, a commit of its own to review before you push (a merge's against
 * its first parent); the box itself has no Copy, as a change is read, not pasted. None without a hunk.
 */
export interface ChangeBoxProps {
  rev: string;
  change: FoundChange;
}

export function ChangeBox({ rev, change }: ChangeBoxProps) {
  const lines = changeLines(change);
  if (!lines) return null;
  const revert = gitRevertCommand(rev, change.merge);
  return (
    <CodeBox
      className="bisectdiff"
      file={change.file}
      lines={lines}
      change
      actions={
        <>
          <EditorButton change={change} className="linkbtn" />
          <CopyButton text={revert} label="git revert" name="Copy git revert" sub={COPY_REVERT_SUB} cmd={`$ ${revert}`}>
            Copy git revert
          </CopyButton>
        </>
      }
    />
  );
}
