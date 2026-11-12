import { num } from '../format.js';

/** A run's preloads, as Provenance's Guard row says them (ProvenanceView.tsx). No DOM here: the tests import it. */

/** A runtime as the guard row names it: Node, Python, Claude Code (the CLI the Claude Agent SDK runs), else the name it said. */
const runtimeName = (r: string) => (r === 'node' ? 'Node' : r === 'python' ? 'Python' : r === 'claude-code' ? 'Claude Code' : r);

/**
 * The preloads of a run, for Provenance's Guard row: the guard it ran, then the processes whose
 * preload said it loaded, by runtime (`block · loaded in 2 Node processes and 1 Python process`), or
 * that none did (`warn · no preload loaded`). The Claude Code CLI the Claude Agent SDK runs loads
 * none, its fence saying so for it: the row says it went unwatched.
 */
export function preloadWords(p: { guard: string; hellos: Readonly<Record<string, number>>; missing?: string | null }): string {
  const loaded = Object.entries(p.hellos)
    .filter(([r, n]) => n > 0 && r !== 'claude-code')
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([r, n]) => `${num(n)} ${runtimeName(r)} ${n === 1 ? 'process' : 'processes'}`);
  const said = loaded.length ? `loaded in ${loaded.length > 1 ? `${loaded.slice(0, -1).join(', ')} and ${loaded.at(-1)!}` : loaded[0]!}` : p.guard === 'off' ? 'no guard' : 'no preload loaded';
  return `${p.guard} · ${said}${p.guard !== 'off' && (p.hellos['claude-code'] ?? 0) > 0 ? ' · the Claude Code CLI unwatched' : ''}`;
}

/** A run's preloads as it keeps them (`meta.preloads`), checked: a run can come from someone else's pack. Null for none. */
export function preloadsOf(meta: { preloads?: unknown } | null | undefined): { guard: 'warn' | 'block' | 'off'; hellos: Record<string, number>; missing: string | null; unguarded: string | null } | null {
  const v = meta?.preloads;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const guard = o.guard === 'warn' || o.guard === 'block' || o.guard === 'off' ? o.guard : null;
  if (!guard) return null;
  const hellos: Record<string, number> = {};
  if (o.hellos && typeof o.hellos === 'object') for (const [r, n] of Object.entries(o.hellos as Record<string, unknown>)) if (/^[a-z][a-z0-9-]{0,19}$/.test(r) && Number.isInteger(n) && (n as number) > 0) hellos[r] = n as number;
  const text = (x: unknown) => (typeof x === 'string' && x ? x.slice(0, 2000) : null);
  return { guard, hellos, missing: text(o.missing), unguarded: text(o.unguarded) };
}
