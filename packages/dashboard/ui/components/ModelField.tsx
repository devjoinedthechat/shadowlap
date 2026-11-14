import { useId } from 'react';
import { fieldModels, FAMILY_NAMES, type ModelFamily, type ModelOption } from '../../src/model-order.js';
import type { ModelChoicesView } from '../estimates-api.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';
import { Copy } from './Copy.js';

/**
 * A model to switch to, for Preview's model switch and Migrate's To: any name the job takes, typed,
 * or one it offers. It offers the runs' own models first in each family, then what each provider lists
 * at its own API (GET /api/model-choices, asked once as the field shows and kept a few seconds on the
 * server), Claude first. Where a provider couldn't be listed, a note sits under it, and the models the
 * config prices are offered; never the built-in price table's names, which are prefixes.
 */

/** The providers' listing, asked once as a field shows; none in a copy or a dashboard that runs nothing. */
export function useModelChoices(): ModelChoicesView | null | undefined {
  const { client, exported, actionsOff } = useApp();
  const api = client.estimates;
  const read = useLoad(() => (api && !exported && !actionsOff ? api.modelChoices() : null), 'model-choices');
  return read.data ?? (read.error ? null : undefined);
}

export interface ModelFieldProps {
  value: string;
  onChange: (model: string) => void;
  /** The runs' own models, most used first. */
  recorded: ReadonlyArray<{ id: string; family: ModelFamily }>;
  listing: ModelChoicesView | null | undefined;
  label?: string;
  /** Offered first, each marked recommended: a retiring model's replacements, for Migrate's Switch to. */
  recommended?: readonly string[];
}

export function ModelField({ value, onChange, recorded, listing, label = 'Model', recommended = [] }: ModelFieldProps) {
  const list = useId();
  const offered = fieldModels(recorded, listing ? [...listing.choices, ...listing.priced] : []);
  const first: ModelOption[] = recommended.map((id) => ({ id, family: offered.find((o) => o.id === id)?.family ?? null, group: 'recommended' }));
  const options = [...first, ...offered.filter((o) => !recommended.includes(o.id))];
  return (
    <>
      <label>
        {label}
        <input type="text" list={list} value={value} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.currentTarget.value.trim())} />
        <datalist id={list}>
          {options.map((o) => (
            <option key={o.id} value={o.id} label={o.group === 'recommended' ? `${o.family ? `${FAMILY_NAMES[o.family]!} · ` : ''}recommended` : `${FAMILY_NAMES[o.family ?? 'other']!} · ${o.recorded ? 'recorded' : o.group}`} />
          ))}
        </datalist>
      </label>
      {/* Set as copy, so a provider's name (OpenAI-compatible) and what it said are never broken inside a word. */}
      {listing?.notes.length ? <Copy className="dlgnote">{listing.notes.map((n) => `${n.group}: ${n.note}`).join('; ')}</Copy> : null}
    </>
  );
}
