// docs/normalizers-and-redaction.md opens with a sample configuration and the commands that write it.
// Readers copy both, so both are held to the code: the commands write exactly the sample's rules, and
// those rules make two runs of an agent that sends a new id each time match, and nothing more.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { applyNormalizers, type Normalizer } from '@shadowlap/engine';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const page = readFileSync(join(ROOT, 'docs', 'normalizers-and-redaction.md'), 'utf8');

/** The page's first JSON block: the sample configuration. */
const sample = JSON.parse(/^```json\n([\s\S]*?)^```/m.exec(page)![1]) as { normalize: Normalizer[]; redact: Normalizer[] };

/** The `shadowlap normalize add` commands under "## Normalizers", as argv. */
const commands = (/^## Normalizers\n[\s\S]*?^```sh\n([\s\S]*?)^```/m.exec(page)?.[1] ?? '')
  .split('\n')
  .filter((l) => l.startsWith('shadowlap normalize add '))
  .map((l) => [...l.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]).slice(1));

const temp: string[] = [];
afterAll(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

describe('the normalizers page', () => {
  it('shows the commands that write its sample configuration', () => {
    expect(commands.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'shadowlap-normalize-'));
    temp.push(dir);
    for (const argv of commands) {
      const r = spawnSync(process.execPath, [CLI, ...argv], { cwd: dir, encoding: 'utf8', env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' } });
      expect(r.status, `${argv.join(' ')}\n${r.stdout}${r.stderr}`).toBe(0);
    }
    const written = JSON.parse(readFileSync(join(dir, 'shadowlap.config.json'), 'utf8')) as { normalize: Normalizer[] };
    expect(written.normalize).toEqual(sample.normalize);
  });

  it('samples rules that make what an agent makes anew on every run match, and nothing else', () => {
    const request = (userId: string, question: string) => ({ model: 'claude-opus-5', max_tokens: 512, metadata: { user_id: userId }, messages: [{ role: 'user', content: question }] });
    const api = (r: unknown) => applyNormalizers(r, sample.normalize, 'api', 'POST /v1/messages');
    expect(api(request('ca35b35e-b35d-4874-b430-d905bb4d9402', 'refund?'))).toEqual(api(request('599d00cd-757e-4daf-9e49-ad91069b7a1a', 'refund?')));
    expect(api(request('ca35b35e-b35d-4874-b430-d905bb4d9402', 'refund?'))).not.toEqual(api(request('599d00cd-757e-4daf-9e49-ad91069b7a1a', 'escalate?')));

    const ticket = (key: string, title: string) => ({ args: { title, idempotency_key: key } });
    const tool = (r: unknown, name = 'create_ticket') => applyNormalizers(r, sample.normalize, 'tool', name);
    expect(tool(ticket('k-1', 'Refund $240'))).toEqual(tool(ticket('k-2', 'Refund $240')));
    expect(tool(ticket('k-1', 'Refund $240'))).not.toEqual(tool(ticket('k-2', 'Refund $24')));
    // Scoped to its tool: another tool's key stays part of its identity.
    expect(tool(ticket('k-1', 'x'), 'close_ticket')).not.toEqual(tool(ticket('k-2', 'x'), 'close_ticket'));
  });
});
