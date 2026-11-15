import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { setToolTrust, setUnrecorded, type UnrecordedEffect } from '../tool-trust.js';
import { editFolder, expectOf, failed, log } from './settings-edits.js';
import { editWhenFree } from '@shadowlap/engine';

/**
 * Settings → Tools' marks: one tool's trust in shadowlap.config.json, and its Undo; and what a tool
 * Shadowlap doesn't record does, under `tools.unrecorded`, and its Undo.
 *
 *   PUT /api/settings/tools/trust        { tool, trust: 'trusted' | 'untrusted' | null, expect }; answers
 *                                        { tool, trust, was, changed, version, line }
 *   PUT /api/settings/tools/unrecorded   { tool, effect: 'read' | 'write' | null, expect }; answers
 *                                        { tool, effect, was, changed, version, line }
 *
 * Against the version the page read (`expect`), as Settings' other edits: a file changed since is a
 * 409. An Undo names the version the mark wrote and puts `was` back, null taking the key out. A tool
 * named `unrecorded` is refused, since `tools.unrecorded` declares the tools Shadowlap doesn't record.
 * The mark lands in the activity feed (`tool.trust`), and a declaration too (`tool.unrecorded`).
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

/** A tool the agent runs unrecorded, by the name the model called it: one line, nothing hidden in it. */
function unrecordedToolOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > NAME_MAX || /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw new HttpError(400, `tool is the tool's name as the model called it, one line of at most ${NAME_MAX} characters`);
  return value;
}

function effectOf(value: unknown): UnrecordedEffect | null {
  if (value === 'read' || value === 'write' || value === null) return value;
  throw new HttpError(400, 'effect is "read", "write" or null (no declaration)');
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

  router.put('/settings/tools/unrecorded', async (r) => {
    const body = await r.body();
    const tool = unrecordedToolOf(body.tool);
    const effect = effectOf(body.effect);
    const expect = expectOf(body.expect);
    const cwd = editFolder(ctx);
    try {
      const written = await editWhenFree((o) => setUnrecorded(cwd, tool, effect, { ...o, expect }));
      log(ctx, written.event ? [written.event] : [], cwd);
      const { event: _event, ...answer } = written;
      r.json(answer);
    } catch (err) {
      failed(ctx, err, cwd);
    }
  });
}
