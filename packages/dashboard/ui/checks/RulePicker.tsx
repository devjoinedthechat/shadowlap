import { isObject } from '../../../engine/src/is-object.js';
import type { GoldenEntry } from '../checks-api.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { goldenName } from '../format.js';
import type { Settled, Unit } from './model.js';

/**
 * The golden's checks, one row a check in the file's order, each labelled as the engine labels it:
 * the rule being built reads `new`, one edited `changed`, one removed crossed out with Keep, and a
 * tool's count another of the same tool replaces `replaced`. Rows end on Edit and Remove; a refused
 * rule reads in amber with the engine's words. The golden it goes to heads the list, a picker while a
 * check from a call is added for an agent with more than one golden.
 */
export interface RulePickerProps {
  settled: Settled;
  units: readonly Unit[];
  active: number;
  goldens: readonly GoldenEntry[];
  golden: GoldenEntry | null;
  picker: boolean;
  onGolden: (path: string) => void;
  onEdit: (i: number) => void;
  onRemove: (i: number) => void;
  onKeep: (i: number) => void;
  onAdd: () => void;
}

export function RulePicker({ settled, units, active, goldens, golden, picker, onGolden, onEdit, onRemove, onKeep, onAdd }: RulePickerProps) {
  const blank = units.some((u) => !u.orig && !u.f && !u.rule);
  const gate = golden && isObject(golden.entry) && golden.entry.injection !== undefined ? golden.entry.injection : undefined;
  return (
    <section className="cb-sec">
      <p className="cb-k">
        {golden ? (
          <>
            <span className="k">Checks of</span>
            {picker ? (
              <select className="cb-sel" aria-label="The golden it goes to" value={golden.path} onChange={(e) => onGolden(e.target.value)}>
                {goldens.map((g) => (
                  <option key={g.path} value={g.path}>
                    {goldenName(g.path)}
                  </option>
                ))}
              </select>
            ) : (
              <code className="cb-code ink">{goldenName(golden.path)}</code>
            )}
            <span className="cb-sub">
              {golden.mode.label} · {golden.path}
            </span>
          </>
        ) : (
          <span className="k">Checks</span>
        )}
      </p>
      <ul className="cb-units">
        {settled.rows.map((r, i) => {
          const u = units[i]!;
          const on = i === active;
          const bad = !r.f && !!r.why && (u.rule?.kind === 'json' || settled.refusal?.at === i);
          const cls = [on ? 'on' : '', u.gone || r.replaced ? 'gone' : '', r.f ? '' : 'draft', bad ? 'bad' : ''].filter(Boolean).join(' ');
          return (
            <li key={i} className={cls || undefined}>
              <span className="cb-ul">
                {r.labels.map((l, k) => (
                  <code key={k}>{l}</code>
                ))}
              </span>
              <span className="cb-ua">
                {r.tag ? <em>{r.tag}</em> : null}
                {on ? null : u.gone ? (
                  <button className="linkbtn" type="button" onClick={() => onKeep(i)}>
                    Keep
                  </button>
                ) : (
                  <button className="linkbtn" type="button" onClick={() => onEdit(i)}>
                    Edit
                  </button>
                )}
                {(on && (u.orig || units.length > 1)) || (!on && !u.gone) ? (
                  <button className="linkbtn" type="button" onClick={() => onRemove(i)}>
                    Remove
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {blank ? null : (
        <button className="linkbtn cb-addu" type="button" onClick={onAdd}>
          <Icon name="plus" />
          Add rule
        </button>
      )}
      {gate === undefined ? null : (
        <p className="cb-note cb-gate">
          <span className="k">Injection gate</span>
          <span className="cb-gv" tabIndex={0} data-tip={tipCard('Its injection gate', [], 'Set in its tests entry beside expect, not here', `"injection": ${JSON.stringify(gate)}`)}>
            set in its tests entry
          </span>
        </p>
      )}
    </section>
  );
}
