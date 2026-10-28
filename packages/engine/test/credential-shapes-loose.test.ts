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

describe('an event stream and lines of JSON', () => {
  it("reads an event's data lines joined, as a client does, past a field it ignores and a byte-order mark", () => {
    const across = `event: token\ndata: {"access_token":\ndata: "${S('SSEMULTI')}", "expires_in": 3600}\n\ndata: [DONE]\n\n`;
    expect(maskTextCredentials(across)).toBe(`event: token\ndata: {"access_token":\ndata: "${C}", "expires_in": 3600}\n\ndata: [DONE]\n\n`);
    expect(maskTextCredentials(`foo: bar\ndata: ${tok('SSEUNKNOWN')}\n\n`)).toBe(`foo: bar\ndata: ${MASKED}\n\n`);
    expect(maskTextCredentials(`\uFEFFdata: ${tok('SSEBOM')}\n\n`)).toBe(`\uFEFFdata: ${MASKED}\n\n`);
    // Each event apart, a line each, as before.
    expect(maskTextCredentials(`data: ${tok('SSEA')}\n\ndata: ${tok('SSEB')}\n\n`)).toBe(`data: ${MASKED}\n\ndata: ${MASKED}\n\n`);
    expect(maskTextCredentials('data: {"text":"hi"}\n\n')).toBeNull();
  });

  it('masks each line of JSON with a line that is none among them, left as it is', () => {
    expect(maskTextCredentials(`${tok('NDLOGA')}\nINFO done\n${tok('NDLOGB')}\n`)).toBe(`${MASKED}\nINFO done\n${MASKED}\n`);
    expect(maskTextCredentials(`{"ok":true}\nnot json\n{"name":"refund"}\n`)).toBeNull();
  });
});

describe('name-value XML and HTML', () => {
  it('reads an element named by its name or key attribute as by its tag, and masks its value', () => {
    expect(maskTextCredentials(`<properties><entry key="db.password">${S('XMLENTRY')}</entry><entry key="db.host">db.internal</entry></properties>`)).toBe(`<properties><entry key="db.password">&lt;CREDENTIAL&gt;</entry><entry key="db.host">db.internal</entry></properties>`);
    expect(maskTextCredentials(`<config><property name="api_key" value="${S('XMLPROPVALUE')}"/><property name="region" value="eu"/></config>`)).toBe(`<config><property name="api_key" value="&lt;CREDENTIAL&gt;"/><property name="region" value="eu"/></config>`);
    expect(maskTextCredentials(`<html><body><form method="post"><input type="hidden" name="SAMLResponse" value="PHNhbWw+${S('HTMLSAML')}"/><input name="RelayState" value="/home"></form><p>Signing in</p></body></html>`)).toBe(`<html><body><form method="post"><input type="hidden" name="SAMLResponse" value="&lt;CREDENTIAL&gt;"/><input name="RelayState" value="/home"></form><p>Signing in</p></body></html>`);
    expect(maskTextCredentials(`<html><head><meta name="csrf-token" content="${S('HTMLCSRF')}"><meta name="viewport" content="width=device-width"></head><body>Hi</body></html>`)).toBe(`<html><head><meta name="csrf-token" content="&lt;CREDENTIAL&gt;"><meta name="viewport" content="width=device-width"></head><body>Hi</body></html>`);
  });

  it('masks everything inside an element its name attribute names as a credential, a SAML attribute’s value', () => {
    expect(maskTextCredentials(`<AttributeStatement><Attribute Name="password"><AttributeValue>${S('SAMLATTRVAL')}</AttributeValue></Attribute><Attribute Name="email"><AttributeValue>a@example.com</AttributeValue></Attribute></AttributeStatement>`)).toBe(`<AttributeStatement><Attribute Name="password"><AttributeValue>&lt;CREDENTIAL&gt;</AttributeValue></Attribute><Attribute Name="email"><AttributeValue>a@example.com</AttributeValue></Attribute></AttributeStatement>`);
    // An element named as one by its tag holds its own text alone: each element in it is judged by its own name, as an STS answer's are.
    expect(maskTextCredentials(`<r><Credentials><AccessKeyId>ASIAEXAMPLE</AccessKeyId><SessionToken>${S('XMLSTS')}</SessionToken></Credentials></r>`)).toBe('<r><Credentials><AccessKeyId>ASIAEXAMPLE</AccessKeyId><SessionToken>&lt;CREDENTIAL&gt;</SessionToken></Credentials></r>');
    expect(maskTextCredentials(`<r><Password><!-- c -->${S('XMLCOMMENTLEAF')}</Password></r>`)).toBe(`<r><Password><!-- c -->&lt;CREDENTIAL&gt;</Password></r>`);
    expect(maskTextCredentials(`<r><SecretAccessKey>${S('XMLTRAIL')}</SecretAccessKey></r>\nEOF`)).toBe('<r><SecretAccessKey>&lt;CREDENTIAL&gt;</SecretAccessKey></r>\nEOF');
  });

  it('masks as before a leaf, a CDATA section and an attribute named as a credential, and leaves a page with none as it is', () => {
    const sts = `<?xml version="1.0"?><a:R xmlns:a="u"><a:SessionToken><![CDATA[${S('XMLCDATA')}]]></a:SessionToken><Credentials SecretAccessKey="${S('XMLATTR')}"/><Expiration>2026-10-26</Expiration></a:R>`;
    expect(maskTextCredentials(sts)).toBe(`<?xml version="1.0"?><a:R xmlns:a="u"><a:SessionToken><![CDATA[${C}]]></a:SessionToken><Credentials SecretAccessKey="&lt;CREDENTIAL&gt;"/><Expiration>2026-10-26</Expiration></a:R>`);
    for (const page of ['<html><body><p>token: hello</p><input name="q" value="refund"><br>after</body></html>', '<r><code>EU</code><key>checkout_v2</key></r>']) expect(maskTextCredentials(page), page).toBeNull();
  });
});
