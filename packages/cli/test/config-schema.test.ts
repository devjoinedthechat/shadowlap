import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASELINE_DEFAULTS, injectionTemplates, parseGate, SPRT_DEFAULTS } from '@shadowlap/engine';

/**
 * The published schema for `shadowlap.config.json`. A schema that drifts from the parser is worse
 * than none, so this reads the keys the parser actually looks at out of its source and requires the
 * schema to describe exactly those: adding a config key without adding it to the schema fails here.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const schema = JSON.parse(readFileSync(join(ROOT, 'shadowlap.config.schema.json'), 'utf8')) as {
  $id: string;
  properties: Record<string, unknown>;
  $defs: Record<string, unknown>;
};
const configSource = readFileSync(join(ROOT, 'packages/cli/src/config.ts'), 'utf8');

describe('shadowlap.config.json schema', () => {
  it('describes exactly the keys the parser reads', () => {
    // `parsed.<key>` in loadConfig, plus `tests`, which loadTests reads from the same file.
    const read = new Set([...configSource.matchAll(/\bparsed\.([a-zA-Z]+)/g)].map((m) => m[1]));
    read.add('tests');
    expect(configSource).toContain('.tests'); // the read the line above stands in for

    const described = new Set(Object.keys(schema.properties).filter((k) => k !== '$schema'));
    expect([...described].sort()).toEqual([...read].sort());
  });

  it('allows the $schema key itself, so a config can point at it', () => {
    expect(schema.properties.$schema).toBeDefined();
  });

  it('is identified by a URL that this project owns', () => {
    // Served from the repository rather than a domain the project would have to own and renew.
    // Note it resolves only once the repository is public.
    expect(schema.$id).toBe('https://raw.githubusercontent.com/devjoinedthechat/shadowlap/main/shadowlap.config.schema.json');
  });

  it('describes a gate as the engine reads one, with the defaults it fills in', () => {
    const tests = schema.properties.tests as { additionalProperties: { properties: { gate: { oneOf: Array<{ properties: Record<string, { description?: string }> }> } } } };
    const [sprt, history] = tests.additionalProperties.properties.gate.oneOf;
    expect(Object.keys(sprt.properties).sort()).toEqual(['bad', 'good', 'max', 'risk']);
    expect(Object.keys(history.properties).sort()).toEqual(['baseline', 'drop', 'max', 'min', 'risk', 'window']);
    // Every key it lists, the engine takes; and the defaults it names are the engine's.
    expect(parseGate({ good: 0.95, bad: 0.8, risk: 0.01, max: 120 }, 'g')).toMatchObject({ kind: 'sprt', max: 120 });
    expect(parseGate({ baseline: 'history', drop: 0.2, risk: 0.01, window: 5, min: 6, max: 30 }, 'g')).toMatchObject({ kind: 'baseline', max: 30 });
    expect(sprt.properties.max.description).toContain(`Default ${SPRT_DEFAULTS.max}`);
    expect(history.properties.max.description).toContain(`Default ${BASELINE_DEFAULTS.max}`);
    expect(history.properties.min.description).toContain(`Default ${BASELINE_DEFAULTS.min}`);
  });

  it('rejects unknown keys rather than ignoring them', () => {
    expect((schema as unknown as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it('defines an effect with no default, matching the SDKs', () => {
    expect(schema.$defs.effect).toMatchObject({ enum: ['pure', 'read', 'write'] });
  });

  it('accepts every count form the parser accepts', () => {
    const { pattern } = (schema.$defs.count as { oneOf: [unknown, { pattern: string }] }).oneOf[1];
    const re = new RegExp(pattern);
    for (const ok of ['0', '>= 1', '<= 12', '2-4', '= 3', '>0', ' 5 ']) expect(re.test(ok), ok).toBe(true);
    for (const bad of ['many', '', '1-', '>=']) expect(re.test(bad), bad).toBe(false);
  });

  it('accepts every pattern form a rule can have, and flags a named pattern that does not exist', () => {
    const rule = schema.$defs.rule as { required: string[]; properties: { pattern: { pattern: string }; path: { pattern: string } } };
    const re = new RegExp(rule.properties.pattern.pattern);
    for (const ok of ['uuid', 'ulid', 'iso-date', 'iso-datetime', 'number', 'email', '/req_[a-z0-9]+/', '/a\\/b/gi', '/x/s']) expect(re.test(ok), ok).toBe(true);
    for (const bad of ['uuidd', 'UUID', '', '/a/x', 'req_.*']) expect(re.test(bad), bad).toBe(false);
    // A path alone (the whole value) and a pattern alone (every string) are both rules: only replace is required.
    expect(rule.required).toEqual(['replace']);
  });

  it('accepts the host forms the parser accepts', () => {
    const { pattern } = (schema.properties.http as { propertyNames: { pattern: string } }).propertyNames;
    const re = new RegExp(pattern);
    for (const ok of ['api.example.com', '*.pinecone.io', 'localhost', 'db.internal:5432']) expect(re.test(ok), ok).toBe(true);
    for (const bad of ['http://api.example.com', 'api.example.com/path', '*', '-bad.com']) expect(re.test(bad), bad).toBe(false);
  });

  it('marks tools untrusted and gates goldens on injection tests, with the templates that ship', () => {
    const tools = schema.properties.tools as { additionalProperties: { properties: { trust: { enum: string[] } }; required: string[] } };
    expect(tools.additionalProperties.properties.trust.enum).toEqual(['trusted', 'untrusted']);
    expect(tools.additionalProperties.required).toEqual(['trust']);
    const tests = schema.properties.tests as { additionalProperties: { properties: { injection: { properties: Record<string, unknown> } } } };
    expect(Object.keys(tests.additionalProperties.properties.injection.properties)).toEqual(['obeyed', 'influenced', 'repeat', 'templates', 'payloads', 'baselines', 'liveReads']);
    // The schema's list of template ids is the shipped set's: a template added without it fails here.
    expect((schema.$defs.injectionTemplate as { enum: string[] }).enum).toEqual(injectionTemplates().templates.map((t) => t.id));
  });
});
