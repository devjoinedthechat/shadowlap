// The conformance suite against the two SDKs Shadowlap ships. A third-party client runs the same
// scenarios through runner.mjs; see README.md.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runConformance } from './runner.mjs';
import { SCENARIOS } from './scenarios.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PY_PATH = fileURLToPath(new URL('../../sdks/python', import.meta.url));

const havePython = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const CLIENTS = [
  { name: 'typescript', argv: [process.execPath, `${HERE}clients/typescript/agent.mjs`], cwd: HERE },
  {
    name: 'python',
    argv: ['python3', `${HERE}clients/python/agent.py`],
    cwd: HERE,
    env: { PYTHONPATH: PY_PATH, PYTHONDONTWRITEBYTECODE: '1' },
    skip: havePython ? false : 'python3 not available',
  },
];

for (const client of CLIENTS) {
  describe(`conformance: ${client.name}`, { skip: client.skip }, () => {
    for (const scenario of SCENARIOS) {
      it(`${scenario.name} — ${scenario.why}`, async () => {
        const [result] = await runConformance(client, { only: [scenario.name] });
        assert.ok(result.ok, result.error ?? 'failed');
      });
    }
  });
}
