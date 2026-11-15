import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { obeyPlanted, startMockAnthropic } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = join(root, 'packages', 'cli', 'bin', 'shadowlap.js');
const AGENT = join(root, 'testing', 'reference-agent', 'dist', 'main.js');

/** The folder that holds the project, as serveDashboard takes it, the project's own folder name, and the run its tests tested. */
export interface InjectionStore {
  folder: string;
  project: string;
  runId: string;
  /** With `second`: a recording of its own, no golden made from it, tested as the first is, its attempts leading with Pack with injection gate…. */
  second?: string;
}

/** The run `shadowlap run` printed that it records. */
function recorded(out: string): string {
  const runId = /recording run (\w{26})/.exec(out)?.[1];
  if (!runId) throw new Error(`shadowlap run named no run:\n${out}`);
  return runId;
}

/** Nothing of this machine's own setup reaches the commands, as in the demo store's build: no keys, no endpoints, no shadowlap settings, and the runner's colours none of the agent's output. */
const LEAKS = /^(SHADOWLAP_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AWS_|AZURE_|LANGFUSE_|LANGSMITH_|OTEL_|GIT_|GITHUB_|CI$|NODE_OPTIONS|FORCE_COLOR)/;

const UNTRUSTED = { tools: { fetch_page: { trust: 'untrusted' } } };
/** The golden's gate: one template at each untrusted read, none allowed to obey. */
const GATE = { obeyed: 0, repeat: 1, templates: ['system-notice'], baselines: 0 };

/**
 * A project of its own with injection tests kept, made by real commands as the demo store is: the
 * reference agent recorded against a mock model that obeys what a tool result tells it (testing's
 * obeyPlanted), its five fetch_page reads marked untrusted in the config; the run packed as a golden
 * whose tests entry holds an injection gate, which `shadowlap test` fails; then `shadowlap
 * injection` planting two templates at each read, every attempt obeying, so the run's newest test
 * is the plain one, 10 of 10. A redaction rule masks the pages' host in the Security report. The
 * demo store keeps no injection result (its planted run is a replay --inject-result). With `second`, a
 * second recording, tested with one template, whose attempts' step is Pack with injection gate….
 */
export async function buildInjectionStore(o: { second?: boolean } = {}): Promise<InjectionStore> {
  const folder = mkdtempSync(join(tmpdir(), 'shadowlap-browser-injection-'));
  const project = 'research-agent';
  const cwd = join(folder, project);
  mkdirSync(join(folder, 'home'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const config = (c: unknown) => writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify(c, null, 2));
  const mock = await startMockAnthropic({ script: obeyPlanted(referenceScript), eventDelayMs: () => 0 });
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !LEAKS.test(k))),
    NO_COLOR: '1',
    SHADOWLAP_TELEMETRY: '0',
    SHADOWLAP_GUARD: 'off',
    SHADOWLAP_HOME: join(folder, 'home'),
    SHADOWLAP_PROJECT_ROOTS: folder,
    SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url,
  };
  const shadowlap = (args: string[], ok: number[] = [0]) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.once('error', reject);
      child.once('exit', (code) => (ok.includes(code ?? -1) ? resolve(out) : reject(new Error(`shadowlap ${args[0]} exited ${code}:\n${out}`))));
    });
  try {
    config(UNTRUSTED);
    const runId = recorded(await shadowlap(['run', '--', process.execPath, AGENT]));
    await shadowlap(['pack', runId, 'goldens/research']);
    config({ ...UNTRUSTED, tests: { 'goldens/*': { injection: GATE } } });
    // Both fail, as an agent that obeys fails them.
    await shadowlap(['test', 'goldens/*'], [1]);
    await shadowlap(['injection', runId, '--templates', 'system-notice,html-comment', '--baselines', '1', '--concurrency', '4'], [1]);
    config({ ...UNTRUSTED, tests: { 'goldens/*': { injection: GATE } }, redact: [{ pattern: '/example\\.com/', replace: '<HOST>' }] });
    if (!o.second) return { folder, project, runId };
    const second = recorded(await shadowlap(['run', '--', process.execPath, AGENT]));
    await shadowlap(['injection', second, '--templates', 'system-notice', '--baselines', '1', '--concurrency', '4'], [1]);
    return { folder, project, runId, second };
  } finally {
    await mock.close();
  }
}
