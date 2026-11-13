import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { setToolTrust } from '../tool-trust.js';
import { editFolder, expectOf, failed, log } from './settings-edits.js';
import { editWhenFree } from '@shadowlap/engine';

/**
 * Settings → Tools' marks: one tool's trust in shadowlap.config.json, and its Undo.
 *
 *   PUT /api/settings/tools/trust   { tool, trust: 'trusted' | 'untrusted' | null, expect }; answers
 *                                   { tool, trust, was, changed, version, line }
 *
 * Against the version the page read (`expect`), as Settings' other edits: a file changed since is a
 * 409. An Undo names the version the mark wrote and puts `was` back, null taking the key out. A tool
 * named `unrecorded` is refused, since `tools.unrecorded` declares the tools Shadowlap doesn't record.
 * The mark lands in the activity feed (`tool.trust`).
 */

const NAME_MAX = 200;

function toolOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > NAME_MAX) throw new HttpError(400, `tool is the tool's name, at most ${NAME_MAX} characters`);
  if (value === 'unrecorded') throw new HttpError(400, 'tools.unrecorded declares the tools Shadowlap doesn’t record: it is no tool to mark');
  return value;
}

function trustOf(value: unknown): 'trusted' | 'untrusted' | null {
  if (value === 'trusted' || value === 'untrusted' || value === null) return value;
  throw new HttpError(400, 'trust is "trusted", "untrusted" or null (no mark)');
}

export function register(router: Router, ctx: RouteContext): void {
  router.put('/settings/tools/trust', async (r) => {
    const body = await r.body();
    const tool = toolOf(body.tool);
    const trust = trustOf(body.trust);
    const expect = expectOf(body.expect);
    const cwd = editFolder(ctx);
    try {
      const written = await editWhenFree((o) => setToolTrust(cwd, tool, trust, { ...o, expect }));
      log(ctx, written.event ? [written.event] : [], cwd);
      const { event: _event, ...answer } = written;
      r.json(answer);
    } catch (err) {
      failed(ctx, err, cwd);
    }
  });
}
