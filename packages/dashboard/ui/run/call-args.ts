import { isObject } from '../../../engine/src/is-object.js';
import type { CallDetail } from '../api.js';

/** A tool call's arguments, as the inspector reads them from its request: the check menu's rules and the builder's argument picker read by them (CheckMenu.tsx, checks/Builder.tsx). */
export function argsOf(detail: CallDetail): Record<string, unknown> {
  const request = detail.request as { args?: unknown } | null;
  const args = isObject(request) && 'args' in request ? request.args : request;
  return isObject(args) ? args : {};
}
