import { describe, expect, it } from 'vitest';
import { fieldValue, type CallRecord } from '@shadowlap/engine';
import { parseFields } from '../src/commands/fix-flags.js';
import { parseInterventions } from '../src/run-agent.js';

/**
 * A request field in a command shadowlap writes for `--set`: a fix's blame and verify run again, the
 * flags `decisions` and `changes migrate` suggest, a job the dashboard starts, a fork made again.
 * `--set` reads its value as JSON, or else as a bare string, so a string that reads as JSON itself
 * (`"123"`, `"true"`) goes in quotes, or it would come back a number or a boolean.
 */

/** What a recorded request field may hold: strings that read as JSON, strings that don't, and the rest. */
const VALUES: unknown[] = ['123', 'true', 'null', '[1]', '{"a":1}', '"quoted"', ' 7 ', 'high', 'claude-opus-5', 'a=b', '', 123, 0.7, true, null, [1, 'two'], { type: 'adaptive' }];
const cases = VALUES.map((v) => [JSON.stringify(v), v] as const);

/** The agent's model call #2, which replay's `--set <call>:<key>=<value>` names. */
const MODEL_CALL = { runId: 'r', callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'f', occurrence: 0, origin: 'live', effect: null, requestRef: null, meta: {}, at: 0, end: null, attempts: [] } as CallRecord;

describe("a request field in a command's --set", () => {
  it('goes in quotes where it is a string that reads as JSON, and bare where it is any other string', () => {
    expect(['123', 'true', 'null', '[1]'].map(fieldValue)).toEqual(['"123"', '"true"', '"null"', '"[1]"']);
    expect(['high', 'claude-opus-5', 'a=b', ''].map(fieldValue)).toEqual(['high', 'claude-opus-5', 'a=b', '']);
    expect([123, true, null, { type: 'adaptive' }].map(fieldValue)).toEqual(['123', 'true', 'null', '{"type":"adaptive"}']);
  });

  it.each(cases)('comes back as %s from --set <key>=<value>', (_, v) => {
    expect(parseFields([`reasoning=${fieldValue(v)}`], undefined)).toEqual({ reasoning: v });
  });

  it.each(cases)("comes back as %s from replay's --set <call>:<key>=<value>", (_, v) => {
    expect(parseInterventions({ injectAs: 'user', set: [`2:reasoning=${fieldValue(v)}`] }, [MODEL_CALL])?.set).toEqual({ fromCall: 2, fields: { reasoning: v } });
  });
});
