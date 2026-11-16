# @shadowlap/test

Recorded tests for Vitest, Jest and node:test: a test records its agent's model and tool calls on its first run, then replays them offline, with the same answers every time.

```sh
npm install -D @shadowlap/test
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['@shadowlap/test/global-setup'],
    setupFiles: ['@shadowlap/test/setup'],
  },
});
```

```ts
import { expect, test } from 'vitest';
import { currentRecording, recorded } from '@shadowlap/test';

test('escalates a refund above the limit', recorded(async () => {
  await refundAgent('A-1042');
  const rec = currentRecording();
  expect(await rec.called('escalate')).toBe(1);
  expect(await rec.called('issue_refund')).toBe(0);
}));
```

When a change makes the test send a request its recording doesn't have, the test fails with the diff. `currentRecording()` tells what the agent did: `called(name, args?)`, `toolCalls(name?)`, `calls()` and `answer()`.

With Jest, set `globalSetup: '@shadowlap/test/jest/global-setup'`, `globalTeardown: '@shadowlap/test/jest/global-teardown'` and `testEnvironment: '@shadowlap/test/jest/environment'`, and wrap tests in `recorded()` as above. With node:test, run `node --import @shadowlap/test/register --test` and wrap the test's body in `withRecording({ recording: '__recordings__/refund' }, fn)`.

Recordings go to `__recordings__/` beside the test file; commit them. `SHADOWLAP_RECORD=all` records again, and `none`, the default when `CI` is set, only replays. The package brings the [`shadowlap` CLI](https://www.npmjs.com/package/shadowlap) it runs, and needs Node 22.17 or later, not 23.

[Test suites](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/testing.md) covers modes, divergences and the pytest plugin.
