import { ActionButton } from './ActionButton.js';

/**
 * A choice of a few (Chart or Table, Text or Raw, a gate's kind, a transport, a provider, an import
 * source): a row of options, the chosen one ink on a raised ground with a hairline ring, as a
 * filter's chosen chip is; no panel around them and no solid ink pill. Each option is a button that
 * says whether it is pressed, in a group its label names. Turning one thing on and off is a
 * `Switch`, never two options.
 */
export function SegmentedControl<K extends string>({ items, value, onChange, label, labelledBy, describedBy, className, action = false, reads = false, why }: { items: ReadonlyArray<{ key: K; label: string; title?: string }>; value: K; onChange: (k: K) => void; /** The group's name, where no label on the page names it. */ label?: string; /** The ids of a row's label and line, which name and describe the group in place of `label`. */ labelledBy?: string; describedBy?: string; className?: string; /** A choice the server writes: it waits as `ActionButton` does. */ action?: boolean; /** A choice the server only answers for (a preview): it still runs on a read-only dashboard. */ reads?: boolean; why?: string | null }) {
  return (
    <div className={`seg${className ? ` ${className}` : ''}`} role="group" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} aria-describedby={describedBy}>
      {items.map((t) =>
        action ? (
          <ActionButton key={t.key} aria-pressed={value === t.key} why={why} reads={reads} title={t.title} onClick={() => onChange(t.key)}>
            {t.label}
          </ActionButton>
        ) : (
          <button key={t.key} type="button" aria-pressed={value === t.key} title={t.title} onClick={() => onChange(t.key)}>
            {t.label}
          </button>
        ),
      )}
    </div>
  );
}
