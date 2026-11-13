/**
 * How a preview's model field orders what it offers, for the server that prices its first pick and
 * the field that draws it (ui/components/ModelField.tsx), so both start on the same model. No
 * imports: the browser's bundle uses this file as it is.
 */

/** A model's family, as the engine's `modelFamily` names it; null for one it doesn't know. */
export type ModelFamily = 'claude' | 'openai' | 'gemini' | null;

/** A model a preview's field offers: its id, its family, and where it came from (a provider's listing, the config's prices, or the runs). */
export interface ModelOption {
  id: string;
  family: ModelFamily;
  group: string;
  /** One of the models the runs were recorded with. */
  recorded?: boolean;
}

const FAMILY_ORDER: readonly ModelFamily[] = ['claude', 'openai', 'gemini', null];

/** The family's name over its group in the field. */
export const FAMILY_NAMES: Record<string, string> = { claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini', other: 'Other models' };

/** By family, Claude first, each family's models in the order given. */
export function byFamily<T extends { family: ModelFamily }>(models: readonly T[]): T[] {
  return FAMILY_ORDER.flatMap((f) => models.filter((m) => m.family === f));
}

/** What the field offers: the runs' models first in each family, then those listed, each once. */
export function fieldModels(recorded: ReadonlyArray<{ id: string; family: ModelFamily }>, listed: readonly ModelOption[]): ModelOption[] {
  const out: ModelOption[] = recorded.map((r) => ({ id: r.id, family: r.family, group: 'Recorded with', recorded: true }));
  for (const m of listed) if (!out.some((o) => o.id === m.id)) out.push(m);
  return byFamily(out);
}

/** The model the field starts on: the first it offers that isn't the one the runs use most; null where it offers no other. */
export function startModel(models: readonly ModelOption[], most: string | null): string | null {
  return models.find((m) => m.id !== most)?.id ?? null;
}
