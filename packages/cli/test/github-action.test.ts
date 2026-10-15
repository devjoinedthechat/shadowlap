import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { githubAnnotations, markdownReport, testReport, type PackResult } from '../src/test-report.js';

/**
 * The GitHub Action's script (action/run.mjs) run the way action.yml runs it, against the committed
 * golden recording: inputs in INPUT_* variables, outputs and the job summary in the files GitHub
 * names in GITHUB_OUTPUT and GITHUB_STEP_SUMMARY.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUN = join(ROOT, 'action', 'run.mjs');
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function action(inputs: Record<string, string>, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-action-'));
  dirs.push(dir);
  const output = join(dir, 'output');
  const summary = join(dir, 'summary.md');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  // The test history goes to a store of the test's own, not the repository's.
  const env: NodeJS.ProcessEnv = { ...process.env, SHADOWLAP_CLI: CLI, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir, NO_COLOR: '1', SHADOWLAP_GUARD: 'off', INPUT_STORE: join(dir, 'shadowlap.db'), ...extraEnv };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k}`] = v;
  const r = spawnSync(process.execPath, [RUN], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { code: r.status, out: `${r.stdout}${r.stderr}`, outputs, summary: readFileSync(summary, 'utf8') };
}

describe('the GitHub Action', () => {
  it('passes a clean replay and reports it in the outputs and the job summary', () => {
    const r = action({ RECORDINGS: 'testing/golden/*', WORKING_DIRECTORY: ROOT, GUARD: 'off' });
    expect(r.code).toBe(0);
    expect(r.outputs).toMatchObject({ passed: '1', failed: '0' });
    expect(readFileSync(r.outputs['report-json']!, 'utf8')).toContain('"passed": 1');
    expect(r.summary).toContain('### Shadowlap: 1 recording passed');
    expect(r.summary).toMatch(/✅ \| `reference-agent` \| clean \| 30\/30/);
    expect(r.out).not.toContain('::error');
  });

  it('fails a diverging replay, annotates it and puts the diff in the summary', () => {
    const r = action({ RECORDINGS: 'testing/golden/reference-agent', WORKING_DIRECTORY: ROOT, GUARD: 'off' }, { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(r.code).toBe(1);
    expect(r.outputs).toMatchObject({ passed: '0', failed: '1' });
    expect(r.out).toContain('::error file=testing/golden/reference-agent/run.json,title=Shadowlap%3A reference-agent::diverged at call 3');
    expect(r.summary).toContain('### Shadowlap: 1 of 1 recording failed');
    expect(r.summary).toContain('+ "You are a research agent. Use the tools, then email a summary. Be brief."');
    expect(r.summary).toContain('shadowlap pack <run> <dir>');
  });

  it('reports without failing the step when fail-on-divergence is false', () => {
    const r = action({ RECORDINGS: 'testing/golden/reference-agent', WORKING_DIRECTORY: ROOT, GUARD: 'off', FAIL_ON_DIVERGENCE: 'false', ANNOTATIONS: 'false', SUMMARY: 'false' }, { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(r.code).toBe(0);
    expect(r.outputs.failed).toBe('1');
    expect(r.out).not.toContain('::error');
    expect(r.summary).toBe('');
  });

  it('says what is wrong with its inputs', () => {
    const none = action({ RECORDINGS: 'goldens/*', WORKING_DIRECTORY: ROOT });
    expect(none.code).toBe(1);
    expect(none.out).toContain('no recordings found for goldens/*');
    const bad = action({ RECORDINGS: 'testing/golden/*', WORKING_DIRECTORY: ROOT, WRITES: 'maybe' });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('input writes must be block, stub or allow');
    const deep = action({ RECORDINGS: 'testing/*/reference-agent', WORKING_DIRECTORY: ROOT });
    expect(deep.out).toContain('only the last part of a recordings path may contain a wildcard');
  });
});

describe('test reports', () => {
  const failed: PackResult = { name: 'summarize|thread', dir: 'goldens\\summarize', golden: 'goldens/summarize', ok: false, failure: 'diverged', runId: null, runs: [], goldenRunId: null, expect: null, updated: null, message: 'diverged at call 3 (api POST /v1/messages)', details: 'a ``` fence\n50% of it: here, there', output: 'Error: boom', seconds: 1, calls: { total: 5, replayed: 2, live: 3, blocked: 0, stubbed: 0 }, upstreamRequests: 0, tokensNotRespent: 1200, divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages' }, checks: null, attempts: null };
  const clean: PackResult = { ...failed, name: 'triage', dir: 'goldens/triage', golden: 'goldens/triage', ok: true, failure: null, message: null, details: null, output: null, calls: { total: 30, replayed: 30, live: 0, blocked: 0, stubbed: 0 }, divergence: null };

  it('writes Markdown that survives pipes and backticks in its content', () => {
    const md = markdownReport(testReport([clean, failed]));
    expect(md).toContain('| ✅ | `triage` | clean | 30/30 | 1k |');
    expect(md).toContain('| ❌ | `summarize\\|thread` | diverged at call 3 (api POST /v1/messages) | 2/5 | 1k |');
    expect(md).toContain('````text\na ``` fence');
  });

  it('escapes GitHub annotation properties and data', () => {
    expect(githubAnnotations(testReport([clean, failed]))).toBe('::error file=goldens/summarize/run.json,title=Shadowlap%3A summarize|thread::diverged at call 3 (api POST /v1/messages)%0A%0Aa ``` fence%0A50%25 of it: here, there');
  });
});
