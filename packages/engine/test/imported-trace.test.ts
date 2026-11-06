import { describe, expect, it } from 'vitest';
import { importedTrace, redactRunDetails, type Normalizer, type RunRecord } from '../src/index.js';

/**
 * The trace an import read a run from, with its page in the trace store (`meta.imported.url`): read
 * again on the way out, as a pack or a pushed run can carry anything, so only an http or https page
 * on a run from a trace store is ever linked to; and a redacted copy masks the page as it masks the
 * rest of the run.
 */

const ID = '7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07';
const PAGE = `https://cloud.langfuse.com/project/cm1shopproject/traces/${ID}`;

function run(imported: Record<string, unknown>): RunRecord {
  return { runId: '01M5GRX8K406H4KHQ7DEKYWTSZ', parentRunId: null, mode: 'record', status: 'completed', command: { argv: ['<no-recorded-command>'], cwd: '/work' }, codeVersion: null, startedAt: 1, endedAt: 2, divergence: null, meta: { imported } } as unknown as RunRecord;
}

describe('an imported trace’s page', () => {
  it('names the store and the trace, with the page as an http or https address', () => {
    expect(importedTrace(run({ at: 1, from: 'langfuse:7f3a9c2e', key: ID, url: PAGE }))).toEqual({ url: PAGE, store: 'Langfuse', id: ID });
    expect(importedTrace(run({ at: 1, from: 'langfuse:7f3a9c2e', url: 'http://localhost:3000/project/p/traces/7f3a' }))).toEqual({ url: 'http://localhost:3000/project/p/traces/7f3a', store: 'Langfuse', id: '7f3a9c2e' });
  });

  it('links nothing a pack could slip in: another scheme, credentials, no page, or a run from anywhere but a trace store', () => {
    for (const url of ['javascript:alert(document.cookie)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'https://ops:hunter2@cloud.langfuse.com/project/p', 'not a url', 42, null]) {
      expect(importedTrace(run({ at: 1, from: 'langfuse:7f3a9c2e', key: ID, url })), String(url)).toBeNull();
    }
    expect(importedTrace(run({ at: 1, from: 'langfuse:7f3a9c2e', key: ID }))).toBeNull();
    expect(importedTrace(run({ at: 1, from: 'captures/session.har', url: PAGE }))).toBeNull();
    expect(importedTrace(run({ at: 1, from: 's3://team/support-agent', url: PAGE }))).toBeNull();
    expect(importedTrace({ meta: null })).toBeNull();
  });

  it('masks the page in a redacted copy as it masks the rest, and adds none to a run without one', () => {
    const project: Normalizer = { pattern: '/cm1shopproject/', replace: '<PROJECT>' };
    expect(redactRunDetails(run({ at: 1, from: 'langfuse:7f3a9c2e', key: ID, url: PAGE }), [project]).meta?.imported).toEqual({ at: 1, from: 'langfuse:7f3a9c2e', key: ID, url: `https://cloud.langfuse.com/project/<PROJECT>/traces/${ID}` });
    expect(redactRunDetails(run({ at: 1, from: 'langfuse:7f3a9c2e', key: ID }), [project]).meta?.imported).toStrictEqual({ at: 1, from: 'langfuse:7f3a9c2e', key: ID });
  });
});
