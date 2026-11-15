import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { removeTempProject, tempProject } from '../../../testing/temp-project.mjs';

/**
 * `shadowlap repair` builds each candidate with `build` from shadowlap.config.json where no --build is
 * given, as a terminal and the dashboard's Run repair alike run it. The support agent's model refunds
 * the $240 order whatever its prompt says; a stronger model escalates it, so repair keeps the switch
 * to it, verified in a candidate's worktree, without asking a repairer.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const ORACLE = JSON.stringify({ tools: { issue_refund: { count: 0, args: { amount: 240 } } } });

function script(ctx: ScriptContext) {
  const order = JSON.stringify(ctx.request.messages[0]?.content ?? '').includes('B-7') ? 'B-7' : 'A-1042';
  if (ctx.assistantTurns === 0) return { message: message([toolUse('lookup_order', { order_id: order }, `toolu_lookup_${ctx.requestNo}`)]) };
  if (ctx.assistantTurns === 1) return { message: message([toolUse('read_policy', {}, `toolu_policy_${ctx.requestNo}`)]) };
  if (ctx.assistantTurns === 2) return { message: ctx.request.model === 'big-model' ? message([text('Above the limit.'), toolUse('escalate', { reason: 'above the refund limit' }, `toolu_decide_${ctx.requestNo}`)]) : message([toolUse('issue_refund', { order_id: order, amount: 240 }, `toolu_decide_${ctx.requestNo}`)]) };
  return { message: message([text('Done.')], { stop_reason: 'end_turn' }) };
}

let mock: MockServer;
let project: string;
beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
  project = tempProject('sl-repair-build-');
  copyFileSync(AGENT, join(project, 'agent.mjs'));
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'agent']]) execFileSync('git', args, { cwd: project, stdio: 'ignore' });
});
afterAll(async () => {
  await mock.close();
  removeTempProject(project);
});

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'test-key', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

describe('shadowlap repair with a build in the config', () => {
  it('builds each candidate with it where --build isn\'t given, never in the working tree, and says so', { timeout: 600_000 }, async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
    expect(recorded.code, recorded.out).toBe(0);
    const failed = /recording run (\w{26})/.exec(recorded.out)![1];
    // A build that writes down where it ran, outside every worktree.
    const log = join(project, '.shadowlap', 'builds.log');
    const build = `"${process.execPath}" -e "require('node:fs').appendFileSync(${JSON.stringify(log).replace(/"/g, "'")}, process.cwd() + '\\n')"`;
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ build }));
    // The switch makes each run longer, which this test doesn't weigh.
    const r = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--stronger', 'big-model', '--max-growth', '1000', '--json']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`\n  build: ${build}, from shadowlap.config.json (--build "" for none)\n`);
    expect((JSON.parse(r.stdout) as { candidates: Array<{ state: string }> }).candidates).toEqual([expect.objectContaining({ state: 'accepted' })]);
    // In the candidate's worktree, a temporary one: without --apply the working tree builds nothing.
    const built = readFileSync(log, 'utf8').trim().split('\n');
    expect(built.length).toBeGreaterThanOrEqual(1);
    expect(built.filter((cwd) => cwd === project || !cwd.includes('shadowlap-repair-'))).toEqual([]);
  });
});
