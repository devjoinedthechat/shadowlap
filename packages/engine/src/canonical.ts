/**
 * JSON Canonicalization Scheme, RFC 8785.
 *
 * Object members are sorted by the UTF-16 code units of their names (JavaScript's default string
 * order), no whitespace is emitted, and strings and numbers are serialized exactly as
 * JSON.stringify serializes them, which is what the RFC specifies (ECMAScript's JSON.stringify
 * and Number::toString). `undefined`, functions and symbols are dropped from objects and become
 * `null` in arrays, matching JSON.stringify; objects with `toJSON` (Dates) are serialized through it.
 */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join('');
}

function write(value: unknown, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('RFC 8785 cannot represent NaN or Infinity');
      out.push(JSON.stringify(value));
      return;
    case 'bigint':
      // An integer a double can't hold, kept exact for matching (json-exact.ts): its digits.
      out.push(value.toString());
      return;
    case 'undefined':
    case 'function':
    case 'symbol':
      // Only reachable at the top level or inside arrays: JSON.stringify semantics give `null`.
      out.push('null');
      return;
    case 'object':
      break;
    default:
      throw new TypeError(`cannot canonicalize ${typeof value}`);
  }

  const obj = value as Record<string, unknown> & { toJSON?: (key: string) => unknown };
  if (typeof obj.toJSON === 'function') {
    write(obj.toJSON(''), out);
    return;
  }
  if (Array.isArray(obj)) {
    out.push('[');
    for (let i = 0; i < obj.length; i++) {
      if (i > 0) out.push(',');
      write(obj[i], out);
    }
    out.push(']');
    return;
  }
  const keys = Object.keys(obj)
    .filter((k) => {
      const v = obj[k];
      return v !== undefined && typeof v !== 'function' && typeof v !== 'symbol';
    })
    .sort();
  out.push('{');
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (i > 0) out.push(',');
    out.push(JSON.stringify(k), ':');
    write(obj[k], out);
  }
  out.push('}');
}
