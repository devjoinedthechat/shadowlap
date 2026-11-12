import { type RetirementNotice, retirementTable } from '@shadowlap/engine';
import { migrateArgv } from '../decisions-argv.js';
import { commandLine } from '../fix-shared.js';
import { links } from '../links.js';
import { checkedWords, newestMigrationsFrom } from '../migrate-applied.js';
import { type RetiringModel, retiringModels, soonestFirst } from '../retirements.js';
import type { GoldenSource } from '../tests.js';
import { adviceOf, isAdviceKey } from './advice.js';
import { type LookAdvice, type LookSource, type NeedsLookRow, plural } from './row.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-30` as a row says it: `Nov 30, 2026`. */
export function shortDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]!} ${d!}, ${y!}`;
}

/** What it says the model does, and when, its date as `day` says it: `retires on Nov 30, 2026`, `may shut down from …`, `retired on …`, `is deprecated`. */
export function when(n: Pick<RetirementNotice, 'retires' | 'state' | 'earliest'>, day: (d: string) => string = shortDate): string {
  if (!n.retires) return 'is deprecated';
  if (n.state === 'retired') return `retired on ${day(n.retires)}`;
  return n.earliest ? `may shut down from ${day(n.retires)}` : `retires on ${day(n.retires)}`;
}

/**
 * What a retire row's advice states: the day the model retires (`retires 2026-11-30`), or that it is
 * deprecated with no day, then each golden that calls it, then, once a migration has checked it, what
 * that found (`checked · …`). The day passing is no fact, so a model that retired stays put away; a
 * migration applied is none either, so updating one golden brings no row back.
 */
export function retireFacts(n: Pick<RetiringModel, 'retires' | 'goldens'>, checked: string | null = null): string[] {
  return [n.retires ? `retires ${n.retires}` : 'deprecated', ...n.goldens, ...(checked ? [checked] : [])];
}

/**
 * A retire row's advice, under `retire <model>`. The name is the recording's, so it may make no key
 * (a space inside it, which the table still reads past in a Vertex AI path): that row shows with no
 * Dismiss, rather than failing the whole list.
 */
function retireAdvice(n: RetiringModel): { advice?: LookAdvice } {
  const key = `retire ${n.model}`;
  return isAdviceKey(key) ? { advice: adviceOf(key, retireFacts(n)) } : {};
}

/**
 * A model the goldens' recordings call that retires, by the table that ships with Shadowlap, the
 * soonest first: `claude-sonnet-4-5, used by 2 goldens, retires on Nov 30, 2026`, `in 60 days ·
 * Anthropic recommends claude-sonnet-5-5`, with Migrate to its replacement, which asks first, opening
 * Changes › Migrate. Once a migration from it checked it, the row says how that came out and opens
 * the migration, and once applied it stays while a golden it left behind waits to be updated. A
 * golden not in the store yet (never tested here) can't be read, and is left out.
 */
export const retire: LookSource = {
  id: 'retire',
  group: 'housekeeping',
  order: 20,
  rows: (w) => {
    const sources = w.goldens.filter((g): g is GoldenSource => typeof g !== 'string');
    // One row a model, by its name trimmed, as the table reads it (retirementOf), where its goldens'
    // recordings called it through two platforms (the Gemini API and Vertex AI) or named it with a
    // space or a line break around it: its goldens together, by its soonest notice, which comes first.
    const byModel = new Map<string, RetiringModel>();
    for (const n of retiringModels(w.store, sources, w.now)) {
      const model = n.model.trim();
      const kept = byModel.get(model);
      if (kept) kept.goldens = [...new Set([...kept.goldens, ...n.goldens])];
      else byModel.set(model, { ...n, model, goldens: [...n.goldens] });
    }
    const checked = newestMigrationsFrom(w.store, [...byModel.keys()]);
    return [...byModel.values()]
      .sort(soonestFirst)
      .flatMap((n): NeedsLookRow[] => {
        // Once a migration checked it, the row says how it came out and opens it; once applied with no golden left to update, it goes.
        const m = checked.get(n.model);
        const state = m ? checkedWords(w.store, m) : null;
        if (m && state === null) return [];
        const to = n.replacements[0] ?? null;
        const owner = retirementTable().platforms[n.platform]?.owner ?? null;
        const detail = [n.days !== null && n.days > 0 ? `in ${plural(n.days, 'day')}` : null, n.replacement ? `${owner ? `${owner} recommends` : 'replaced by'} ${n.replacement}` : null].filter((x): x is string => !!x).join(' · ');
        return [{
          key: `attn:retire:${n.model}`,
          group: 'housekeeping',
          kind: 'retire',
          icon: 'retire',
          title: `${n.model}, used by ${plural(n.goldens.length, 'golden')}, ${when(n)}`,
          detail: state ?? detail,
          step: to && !m ? { of: 'migrate', label: `Migrate to ${to}`, from: [n.model], to, goldens: n.goldens, command: commandLine(migrateArgv({ to, targets: n.goldens, from: [n.model] })) } : null,
          href: links.changeSession('migrate', m?.sessionId ?? null),
          runId: null,
          fixId: null,
          at: 0,
          ...retireAdvice(n),
        }];
      });
  },
};
