import { realpathSync } from 'node:fs';
import { editorCommand, editorLine, openEditor, projectFile } from '../editor.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';

/**
 * `POST /api/editor/open { file, line }`: Open in editor (editor.ts). `file` is a path relative to
 * the project folder, a regular file inside it through its real path; `line` a line number. Nothing
 * else in the request is read. A write, so a read-only dashboard refuses it; with no project folder,
 * or no editor this machine can open, it is refused with why. Meta's `editor` says beforehand.
 */
export function register(router: Router, ctx: RouteContext): void {
  router.post('/editor/open', async (r) => {
    const body = await r.body();
    if (!ctx.project) throw new HttpError(409, 'Open in editor needs the project folder: start the dashboard with shadowlap dashboard in it');
    const editor = editorCommand(ctx.options.editor);
    if ('off' in editor) throw new HttpError(409, editor.off);
    let root: string;
    try {
      root = realpathSync(ctx.project.path);
    } catch {
      throw new HttpError(409, 'the project folder is gone');
    }
    const file = projectFile(root, body.file);
    const line = editorLine(body.line);
    const opened = await openEditor(editor, file.real, line, root, ctx.options.editor);
    if ('error' in opened) throw new HttpError(500, opened.error);
    r.json({ file: file.name, line, editor: editor.name });
  });
}
