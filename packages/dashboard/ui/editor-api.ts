import type { Request } from './settings-api.js';

/** Open in editor, written beside its route (src/routes/editor.ts). */
export interface EditorApi {
  /**
   * Opens a file of the project, by its path relative to the project folder, at a line in the editor
   * $VISUAL or $EDITOR names (`POST /api/editor/open`): the file and line it opened, and the editor.
   * Refused with why for a file outside the folder, and where this machine opens no editor.
   */
  open(file: string, line: number): Promise<{ file: string; line: number; editor: string }>;
}

export function editorApi(request: Request): EditorApi {
  return { open: (file, line) => request('editor/open', { method: 'POST', body: JSON.stringify({ file, line }) }) };
}
