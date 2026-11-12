import type { FoundChange } from '../types.js';

/** Open in editor's words and where it opens (EditorButton.tsx). No DOM here: the tests import it. */

/** Where Open in editor opens a change, and what the server runs for it: none without an editor this machine opens (meta's `editor`, none in a copy), a file inside the project or a line. */
export function editorTarget(change: Pick<FoundChange, 'path' | 'line'> | null | undefined, editor: string | null | undefined): { path: string; line: number; cmd: string } | null {
  if (!change?.path || change.line === null || !editor) return null;
  return { path: change.path, line: change.line, cmd: editor.replace('<file>', change.path).replace('<line>', String(change.line)) };
}

/** Open in editor's card, under its name. */
export const editorSub = (t: { path: string; line: number }): string => `Opens ${t.path} at line ${t.line} in the editor $VISUAL or $EDITOR names`;

/** Its toast once the server opened the file. */
export const editorOpened = (o: { file: string; line: number }): string => `Opened ${o.file} at line ${o.line} in your editor`;
