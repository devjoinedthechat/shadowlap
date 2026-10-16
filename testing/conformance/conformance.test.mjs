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

/**
 * A Python 3 to run the Python client with: SHADOWLAP_PYTHON, else python3, else python, as the other
 * Python tests pick one. Windows installs have python but no python3 (only the Store's stand-in,
 * which exits with an error), so without the fallback the Python client never ran there.
 */
const python = [process.env.SHADOWLAP_PYTHON, 'python3', 'python'].filter(Boolean).find((cmd) => {
  try {
    return execFileSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '3';
  } catch {
    return false;
  }
});

const CLIENTS = [
  { name: 'typescript', argv: [process.execPath, `${HERE}clients/typescript/agent.mjs`], cwd: HERE },
  {
    name: 'python',
    argv: [python ?? 'python3', `${HERE}clients/python/agent.py`],
    cwd: HERE,
    env: { PYTHONPATH: PY_PATH, PYTHONDONTWRITEBYTECODE: '1' },
    skip: python ? false : 'no Python 3 found (python3 or python)',
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
