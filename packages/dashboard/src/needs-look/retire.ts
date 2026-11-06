import { isReservedScope, type RetirementNotice, retirementOf, retirementTable, type Store } from '@shadowlap/engine';
import { commandLine } from '../fix-shared.js';
import { links } from '../links.js';
import type { GoldenSource } from '../tests.js';
import { type LookSource, type NeedsLookRow, plural } from './row.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-30` as a row says it: `Nov 30, 2026`. */
export function shortDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]!} ${d!}, ${y!}`;
}

type Model = { provider: string | null; model: string };

/**
 * The models each golden's recording calls, by run, kept per store: a finished recording never
 * changes, so its calls are read once, not on every look. Shadowlap's own calls (its judge's) are no
 * model the agent uses.
 */
const modelsRead = new WeakMap<Store, Map<string, Model[]>>();

function modelsOf(store: Store, runId: string): Model[] {
  const kept = modelsRead.get(store) ?? new Map<string, Model[]>();
  modelsRead.set(store, kept);
  const known = kept.get(runId);
  if (known) return known;
  const seen = new Map<string, Model>();
  for (const c of store.getCalls(runId)) {
    if (c.kind !== 'api' || isReservedScope(c.meta.scope)) continue;
    const model = c.end?.meta.model ?? c.meta.model ?? null;
    if (!model) continue;
    const provider = c.meta.provider ?? c.end?.meta.provider ?? null;
    seen.set(`${String(provider)}\u0000${model}`, { provider, model });
  }
  const models = [...seen.values()];
  if (store.getRun(runId)?.status !== 'running') kept.set(runId, models);
  return models;
}

/** What it says the model does, and when: `retires on Nov 30, 2026`, `may shut down from …`, `retired on …`, `is deprecated`. */
function when(n: RetirementNotice): string {
  if (!n.retires) return 'is deprecated';
  if (n.state === 'retired') return `retired on ${shortDate(n.retires)}`;
  return n.earliest ? `may shut down from ${shortDate(n.retires)}` : `retires on ${shortDate(n.retires)}`;
}

/**
 * A model the goldens' recordings call that retires, by the table that ships with Shadowlap, the
 * soonest first: `claude-sonnet-4-5, used by 2 goldens, retires on Nov 30, 2026`, `in 60 days ·
 * Anthropic recommends claude-sonnet-5-5`, with Migrate to its replacement, which asks first. A
 * golden not in the store yet (never tested here) can't be read, and is left out.
 */
export const retire: LookSource = {
  id: 'retire',
  group: 'housekeeping',
  order: 20,
  rows: (w) => {
    const byModel = new Map<string, RetirementNotice & { goldens: string[] }>();
    for (const g of w.goldens) {
      const runId = typeof g === 'string' ? null : (g).runId;
      if (!runId || !w.store.getRun(runId)) continue;
      for (const m of modelsOf(w.store, runId)) {
        const key = `${String(m.provider)}\u0000${m.model}`;
        const notice = byModel.get(key) ?? (() => {
          const n = retirementOf(m.provider, m.model, { now: w.now });
          return n ? { ...n, goldens: [] as string[] } : null;
        })();
        if (!notice) continue;
        notice.goldens.push((g as GoldenSource).path);
        byModel.set(key, notice);
      }
    }
    const soonest = (n: RetirementNotice) => (n.days === null ? Number.MAX_SAFE_INTEGER : n.days);
    return [...byModel.values()]
      .sort((a, b) => soonest(a) - soonest(b) || b.goldens.length - a.goldens.length)
      .map((n): NeedsLookRow => {
        const to = n.replacements[0] ?? null;
        const owner = retirementTable().platforms[n.platform]?.owner ?? null;
        const detail = [n.days !== null && n.days > 0 ? `in ${plural(n.days, 'day')}` : null, n.replacement ? `${owner ? `${owner} recommends` : 'replaced by'} ${n.replacement}` : null].filter((x): x is string => !!x).join(' · ');
        return {
          key: `attn:retire:${n.model}`,
          group: 'housekeeping',
          kind: 'retire',
          icon: 'retire',
          title: `${n.model}, used by ${plural(n.goldens.length, 'golden')}, ${when(n)}`,
          detail,
          step: to ? { of: 'migrate', label: `Migrate to ${to}`, from: [n.model], to, goldens: n.goldens, command: commandLine(['migrate', '--to', to, ...n.goldens, '--from', n.model]) } : null,
          href: links.changes(),
          runId: null,
          fixId: null,
          at: 0,
        };
      });
  },
};
