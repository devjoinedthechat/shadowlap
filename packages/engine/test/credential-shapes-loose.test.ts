import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER as C, maskTextCredentials } from '../src/http.js';
import { times, timesOf } from './timing.js';

/**
 * Bodies the credential review found masking read past: JSON among other text, an event stream
 * whose JSON spans lines, lines of JSON with a log line among them, name-value XML and HTML, a
 * token as a URL's name, `key: value` lines, a GraphQL block string. Each holds planted values; the
 * rest of the text stays as sent.
 */

const S = (n: string) => `SLSEC_BP_${n}_q1w2e3r4`;
const tok = (n: string) => JSON.stringify({ access_token: S(n), refresh_token: S(`${n}R`) });
/** What `tok` is masked as. */
const MASKED = JSON.stringify({ access_token: C, refresh_token: C });
const leftIn = (text: string) => [...new Set([...text.matchAll(/SLSEC_BP_[A-Z0-9]+/g)].map((m) => m[0]))];

describe('JSON among other text', () => {
  it('is masked after a comment or `<!--`, before `;` or other text, run together, a line each, in a jQuery JSONP call and in a page', () => {
    const cases: Array<[string, string, string]> = [
      ['block comment', `/* api */ ${tok('BLOCKCOMMENT')}`, `/* api */ ${MASKED}`],
      ['line comment', `// api\n${tok('LINECOMMENT')}`, `// api\n${MASKED}`],
      ['html comment', `<!-- x -->${tok('HTMLCOMMENT')}`, `<!-- x -->${MASKED}`],
      ['anti-XSSI words', `&&&START&&&${tok('AMPSTART')}`, `&&&START&&&${MASKED}`],
      ['a trailing semicolon', `${tok('TRAILSEMI')};`, `${MASKED};`],
      ['text after it', `${tok('TRAILJUNK')}\n<!-- served by x -->`, `${MASKED}\n<!-- served by x -->`],
      ['run together', `${tok('CONCATA')}${tok('CONCATB')}`, `${MASKED}${MASKED}`],
      ['a JSON text sequence', `\x1e${tok('RSSEQA')}\n\x1e${tok('RSSEQB')}\n`, `\x1e${MASKED}\n\x1e${MASKED}\n`],
      ['jQuery JSONP', `typeof cb === 'function' && cb(${tok('JQJSONP')});`, `typeof cb === 'function' && cb(${MASKED});`],
      ['a page’s state', `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${tok('NEXTDATA')}</script></body></html>`, `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${MASKED}</script></body></html>`],
      ['a script’s assignment', `<html><script>window.__STATE__ = ${tok('HTMLASSIGN')};</script></html>`, `<html><script>window.__STATE__ = ${MASKED};</script></html>`],
    ];
    for (const [what, text, want] of cases) expect(maskTextCredentials(text), what).toBe(want);
  });

  it('masks what an object held before it stopped being JSON, reads the text once, and leaves text with none as it is', () => {
    expect(maskTextCredentials(`{"user":{"password":"${S('BROKEN')}"}, not json after all`)).toBe(`{"user":{"password":"${C}"}, not json after all`);
    // An object that stopped before its member's value, then one that is whole.
    expect(maskTextCredentials(`{"a" {"api_key":"${S('AFTERBROKEN')}"}`)).toBe(`{"a" {"api_key":"${C}"}`);
    for (const text of ['function f() { return "x"; }', 'a {b} c', '{"ok":true} and {"name":"refund"}', '{password: "not JSON, a script"}']) expect(maskTextCredentials(text), text).toBeNull();
    // A text that opens objects without end: read once, not once from each `{`.
    const open = (k: number) => '{"a":{"b":'.repeat(k);
    const t = timesOf({ short: () => maskTextCredentials(open(2000)), long: () => maskTextCredentials(open(8000)) }, { rounds: 2 });
    expect(t.long, `4 times the text took ${times(t.long, t.short)} as long`).toBeLessThan(12 * t.short);
    expect(leftIn(maskTextCredentials(`${open(50)}"x"}} {"token":"${S('LATE')}"}`) ?? '')).toEqual([]);
  });
});
