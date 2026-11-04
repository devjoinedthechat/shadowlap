/**
 * A choice of a few (Chart or Table, Text or Raw, a gate's kind, a transport, a provider, an import
 * source): a row of options, the chosen one ink on a raised ground with a hairline ring, as a
 * filter's chosen chip is; no panel around them and no solid ink pill. Each option is a button that
 * says whether it is pressed, in a group its label names. Turning one thing on and off is a
 * `Switch`, never two options.
 */
export function SegmentedControl<K extends string>({ items, value, onChange, label }: { items: ReadonlyArray<{ key: K; label: string; title?: string }>; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map((t) => (
        <button key={t.key} type="button" aria-pressed={value === t.key} title={t.title} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
