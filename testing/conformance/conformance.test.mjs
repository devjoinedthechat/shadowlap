// The conformance suite against the two SDKs shadowlap ships. A third-party client runs the same
// scenarios through runner.mjs; see README.md.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runConformance } from './runner.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { pythonCommand } from '../python-with.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PY_PATH = fileURLToPath(new URL('../../sdks/python', import.meta.url));

/** The Python to run the Python client with, found as the suite's other Python tests find one. */
const python = pythonCommand();

const CLIENTS = [
  { name: 'typescript', argv: [process.execPath, `${HERE}clients/typescript/agent.mjs`], cwd: HERE },
  {
    name: 'python',
    argv: [python ?? 'python3', `${HERE}clients/python/agent.py`],
    cwd: HERE,
    env: { PYTHONPATH: PY_PATH, PYTHONDONTWRITEBYTECODE: '1' },
    skip: python ? false : 'no Python 3.9 or later found (SHADOWLAP_PYTHON, python3 or python)',
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
