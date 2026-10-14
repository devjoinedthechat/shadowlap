export { formatDuration, formatUsd, shortModel } from '../../engine/src/prices.js';
export { shortCallName as callName } from '../../engine/src/labels.js';

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The same, compact, where a row has no room for words: now, 39m, 5h, 3d, then the date. */
export function agoShort(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d`;
  return new Date(ms).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

export const shortId = (id: string) => id.slice(0, 10);

/**
 * Whether a call actually went wrong. A fenced write ends in an error so the agent's tool call
 * throws and the agent handles it, but nothing failed: Shadowlap refused it on purpose, and the
 * Fenced count already says so. Painting it red twice reads as a broken run.
 */
export const isFailure = (c: { origin: string; outcome?: string | null }) =>
  c.outcome === 'error' && c.origin !== 'blocked' && c.origin !== 'stubbed';

export function when(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

export function json(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function copy(text: string): Promise<boolean> {
  return navigator.clipboard?.writeText(text).then(
    () => true,
    () => false,
  ) ?? Promise.resolve(false);
}
