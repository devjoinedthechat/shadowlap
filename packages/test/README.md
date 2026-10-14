# @shadowlap/test

Recorded tests for [Shadowlap](https://github.com/devjoinedthechat/shadowlap). A wrapped test records its agent's model and tool calls on its first run and replays them offline after that: no tokens, no network, the same answers every time. When a code change makes the test send a different request, it fails with the diff.

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    globalSetup: ['@shadowlap/test/global-setup'],
    setupFiles: ['@shadowlap/test/setup'],
  },
});
```

```ts
import { currentRecording, recorded } from '@shadowlap/test';

test('triages the inbox', recorded(async () => {
  const result = await runAgent('triage the inbox');
  expect(result.tickets).toHaveLength(3);
  expect(await currentRecording().called('send_email')).toBe(0);
}));
```

`currentRecording()` tells what the agent did during the test: `called(name, args?)`, `toolCalls(name?)`, `calls()` and `answer()`.

With node:test, run `node --import @shadowlap/test/register --test` and wrap the test body in `withRecording({ recording: 'path' }, fn)`.

Recordings go to `__recordings__/` beside the test file; commit them. `SHADOWLAP_RECORD=all` records again; `none`, the default when `CI` is set, only replays. See [Test suites](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/testing.md).
