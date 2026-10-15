/**
 * Just enough XML for the answers S3 and Azure give: list results, errors and bucket settings. Each
 * is a flat document of known elements, so the elements are found by name; nothing is evaluated.
 */

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner)
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e: string) => {
      const lower = e.toLowerCase();
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'amp') return '&';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
      const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
}

/** The inner XML of every `<tag>…</tag>` (the tag may carry attributes; it must not nest in itself). */
export function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  for (const m of xml.matchAll(re)) out.push(m[1]!);
  return out;
}

/** The text of the first `<tag>…</tag>`, entities decoded; null when absent. An empty `<tag/>` is ''. */
export function xmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (m) return decode(m[1]!);
  return new RegExp(`<${tag}(?:\\s[^>]*)?/>`).test(xml) ? '' : null;
}

/** Escapes text for an XML element. */
export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
