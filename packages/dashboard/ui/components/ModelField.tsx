import { useId } from 'react';
import { fieldModels, FAMILY_NAMES, type ModelFamily } from '../../src/model-order.js';
import type { ModelChoicesView } from '../estimates-api.js';
import { useLoad } from '../hooks.js';
import { useApp } from '../state.js';

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
}

export function ModelField({ value, onChange, recorded, listing, label = 'Model' }: ModelFieldProps) {
  const list = useId();
  const options = fieldModels(recorded, listing ? [...listing.choices, ...listing.priced] : []);
  return (
    <>
      <label>
        {label}
        <input type="text" list={list} value={value} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.currentTarget.value.trim())} />
        <datalist id={list}>
          {options.map((o) => (
            <option key={o.id} value={o.id} label={`${FAMILY_NAMES[o.family ?? 'other']!} · ${o.recorded ? 'recorded' : o.group}`} />
          ))}
        </datalist>
      </label>
      {listing?.notes.length ? <p className="dlgnote">{listing.notes.map((n) => `${n.group}: ${n.note}`).join('; ')}</p> : null}
    </>
  );
}
