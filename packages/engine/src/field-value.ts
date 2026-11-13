// No imports: the dashboard's browser bundle reads this file as it is, so a dialog's command sets a
// field as the job does.

/**
 * A request field's value as `--set field=value` gives it, for a parser that reads it as JSON or else
 * as a bare string: anything but a string as JSON, and a string as it is, unless `--set` would read it
 * back as something else (`1`, `true`, `[1]`), when it goes as JSON too.
 */
export function fieldValue(v: unknown): string {
  if (typeof v !== 'string') return JSON.stringify(v);
  try {
    JSON.parse(v);
    return JSON.stringify(v);
  } catch {
    return v;
  }
}
