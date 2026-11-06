import type { RunDetail } from '../api.js';
import { tipCard } from '../components/HoverCard.js';

/**
 * Open in Langfuse ↗: the trace an imported run was read from, on its page in the trace store it
 * came from, in a tab of its own. Drawn only where the import kept the page (the server's `trace`).
 */
export function TraceLink({ trace }: { trace: RunDetail['trace'] }) {
  if (!trace) return null;
  const host = trace.url.replace(/^https?:\/\//, '').split('/')[0] ?? trace.url;
  const tip = tipCard(`Open in ${trace.store}`, [], `The trace it was imported from, ${trace.id}, on ${host}`);
  return (
    <a className="btn" href={trace.url} target="_blank" rel="noopener noreferrer" data-tip={tip}>
      Open in {trace.store} <span aria-hidden="true">↗</span>
    </a>
  );
}
