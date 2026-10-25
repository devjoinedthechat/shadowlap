import { unrecordedTools, type RunRecord, type Store, type UnrecordedTool } from '@shadowlap/engine';

/**
 * What a run did that Shadowlap did not record, read from the run itself, for its page: the tools the
 * model called whose calls the run never recorded (the engine's `unrecordedTools`, contract 10), each
 * with how often, from which model call and what it does, as the project's `tools.unrecorded`
 * declares it, or a built-in's or its name says; and the WebSockets the run's sidecar tunnelled to a
 * provider or refused, as the run keeps them. A replay serves the model's answers again, so it runs
 * those tools again for real, and `shadowlap replay` and `test` refuse one that writes.
 */

export interface UnrecordedView {
  runId: string;
  tools: UnrecordedTool[];
  /**
   * A partial recording (an import of a trace or a capture, `meta.covers`), which holds its model
   * calls alone by design: its replay runs every other tool live, and nothing refuses it.
   */
  partial: boolean;
}

/** The run's unrecorded tools, under the effects the project's config declares. */
export function runUnrecorded(store: Store, run: Pick<RunRecord, 'runId' | 'meta'>, declared: Readonly<Record<string, 'read' | 'write'>> = {}): UnrecordedView {
  let tools: UnrecordedTool[];
  try {
    tools = unrecordedTools(store, run.runId, { declared });
  } catch {
    tools = [];
  }
  return { runId: run.runId, tools, partial: !!run.meta?.covers?.length };
}

/** A WebSocket the run's sidecar saw under a provider: its provider and path, how often, and whether it went live or was refused. */
export interface WebSocketView {
  target: string;
  count: number;
  action: 'tunnelled' | 'refused';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The WebSockets a run keeps (`meta.websockets`, as the sidecar's end of a run reports them), checked
 * entry by entry: a run can come from someone else's pack. Null when it keeps none.
 */
export function runWebSockets(run: Pick<RunRecord, 'meta'>): WebSocketView[] | null {
  const v: unknown = (run.meta as Record<string, unknown> | undefined)?.websockets;
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((w): w is Record<string, unknown> => isObject(w) && typeof w.target === 'string' && w.target.length <= 300 && Number.isInteger(w.count) && (w.count as number) > 0)
    .slice(0, 50)
    .map((w) => ({ target: w.target as string, count: w.count as number, action: w.action === 'refused' ? ('refused' as const) : ('tunnelled' as const) }));
  return out.length ? out : null;
}
