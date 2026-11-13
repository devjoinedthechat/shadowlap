import { listModelChoices, modelFamily, type ListModelsInput, type ModelListing, type Price } from '@shadowlap/engine';
import type { RouteContext } from './context.js';
import { byFamily, type ModelOption } from './model-order.js';

/**
 * The models a picker offers, listed once for every route that asks: Training's Score a model
 * (`GET /api/models`) and a preview's model field (`GET /api/model-choices`). Each configured provider
 * is asked with the keys already on this machine, and Ollama only where a server already answers;
 * nothing is started, every request times out fast, and a provider that doesn't answer becomes a
 * note. A listing is kept for a few seconds, so opening a dialog again doesn't ask again. It is
 * network I/O, not a read of runs, so it never goes through the read pool.
 */

/** How long a model listing is reused. */
const LISTING_TTL_MS = 15_000;
/** The listings kept at once: Training's and a preview's ask with different inputs, and neither evicts the other. */
const KEPT = 4;

type Listing = { at: number; value: Promise<ModelListing> };
const kept = new WeakMap<RouteContext, Map<string, Listing>>();

/** Prices from the config as it is now, else the ones the dashboard started with. */
export function configPrices(ctx: RouteContext): Record<string, Price> | undefined {
  try {
    return ctx.config().prices ?? ctx.options.prices;
  } catch {
    return ctx.options.prices;
  }
}

/** The model choices for `input`, at the config's prices, from the listing kept for this dashboard when it is fresh. */
export function listModels(ctx: RouteContext, input: Omit<ListModelsInput, 'prices' | 'env' | 'fetch' | 'timeoutMs'>): Promise<ModelListing> {
  const o = ctx.options.training ?? {};
  const p = configPrices(ctx);
  const key = JSON.stringify([input, p ?? null]);
  const listings = kept.get(ctx) ?? new Map<string, Listing>();
  kept.set(ctx, listings);
  const had = listings.get(key);
  if (had && Date.now() - had.at < LISTING_TTL_MS) return had.value;
  const value = listModelChoices({ ...input, ...(p ? { prices: p } : {}), ...(o.env ? { env: o.env } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
  const entry = { at: Date.now(), value };
  listings.delete(key);
  listings.set(key, entry);
  if (listings.size > KEPT) listings.delete(listings.keys().next().value!);
  value.catch(() => {
    if (listings.get(key) === entry) listings.delete(key);
  });
  return value;
}

/** The models a preview's field offers beside the runs' own: what each provider lists at its own API, the config's priced models where one couldn't be listed, and why. */
export interface ModelChoicesView {
  choices: ModelOption[];
  /** Providers that couldn't be listed, and why: a note under the field. */
  notes: ModelListing['notes'];
  /** The models the config's `prices` names, offered where a provider couldn't be listed; never the built-in table's, whose keys are prefixes. */
  priced: ModelOption[];
}

/** The group of a model the config's `prices` names. */
const PRICED = 'Priced in your config';

/**
 * What a switch can be asked of (`GET /api/model-choices`): the choices asked at a provider's own API
 * (no endpoint, nothing on this machine), as a switch sends the recorded request there. A read-only
 * dashboard asks no provider.
 */
export async function modelChoices(ctx: RouteContext): Promise<ModelChoicesView> {
  const listing = await listModels(ctx, { recorded: [], tokens: null, ...(ctx.readOnly ? { ask: false } : {}) });
  const choices = listing.choices.filter((c) => c.baseUrl === null && !c.local).map((c) => ({ id: c.id, family: modelFamily(c.id), group: c.group }));
  const priced = listing.notes.length ? Object.keys(configPrices(ctx) ?? {}).filter((id) => !choices.some((c) => c.id === id)).map((id) => ({ id, family: modelFamily(id), group: PRICED })) : [];
  return { choices: byFamily(choices), notes: listing.notes, priced };
}
