/**
 * The INI dialect of ~/.aws/config and ~/.aws/credentials: `[section]` headers, `key = value`
 * lines, `#` and `;` comments, and indented continuation lines for nested settings (kept as text).
 */
export function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  let lastKey: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*([#;]|$)/.test(raw)) continue;
    const header = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(raw);
    if (header) {
      const name = header[1]!.trim().replace(/\s+/g, ' ');
      current = sections.get(name) ?? new Map<string, string>();
      sections.set(name, current);
      lastKey = null;
      continue;
    }
    if (!current) continue;
    if (/^\s/.test(raw) && lastKey) {
      // A nested setting (`s3 =` then indented lines): kept, not interpreted.
      current.set(lastKey, `${current.get(lastKey) ?? ''}\n${raw.trim()}`);
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    const key = raw.slice(0, eq).trim().toLowerCase();
    const value = raw
      .slice(eq + 1)
      .replace(/\s+[#;].*$/, '')
      .trim();
    current.set(key, value);
    lastKey = key;
  }
  return sections;
}
