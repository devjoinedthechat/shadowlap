# Test suites

Tests that call a model are slow, cost tokens, and don't give the same answer twice. Mark a test, and Shadowlap records its model and tool calls the first time it runs and replays them after that: offline, instantly, and with the same answers every time. When a code change makes the test send a different request, the test fails with the diff.

It works like vcrpy or Polly.js, with Shadowlap's matching (calls are matched by what they ask, not the order they arrive), its tool effects (a replay never runs a write again) and its reports.

## pytest

Install the Python package ([from a clone](./sdk.md#install) until it is published); the plugin loads itself and does nothing for tests without the marker.

```python
import pytest

@pytest.mark.shadowlap
def test_triage():
    result = run_agent("triage the inbox")
    assert len(result.tickets) == 3
```

The recording goes next to the test: `__recordings__/test_agent/test_triage/`. Commit it. `@pytest.mark.shadowlap(recording="path")` puts it somewhere else. Parametrized tests get one recording per case, and pytest-xdist works: each worker gets its own slot.

Other runners can use the context manager the plugin is built on:

```python
from shadowlap.testing import recording

with recording("tests/__recordings__/triage"):
    result = run_agent("triage the inbox")
```

## Vitest

Install `@shadowlap/test` as a dev dependency ([from a clone](./sdk.md#install) until it is published), and add its setup:

```js
// vitest.config.ts
export default defineConfig({
  test: {
    globalSetup: ['@shadowlap/test/global-setup'],
    setupFiles: ['@shadowlap/test/setup'],
  },
});
```

```ts
import { recorded } from '@shadowlap/test';

test('triages the inbox', recorded(async () => {
  const result = await runAgent('triage the inbox');
  expect(result.tickets).toHaveLength(3);
}));
```

The recording is named after the test, including its `describe` blocks, and lives in `__recordings__/<file>/` beside the test file. `recorded(fn, { recording: 'path' })` overrides that. Test files that run in parallel workers each get their own slot.

## node:test

```sh
node --import @shadowlap/test/register --test
```

```js
import { withRecording } from '@shadowlap/test';

test('triages the inbox', () =>
  withRecording({ recording: '__recordings__/triage' }, async () => {
    const result = await runAgent('triage the inbox');
    assert.equal(result.tickets.length, 3);
  }));
```

## What the agent did

A test can check what the agent did as well as what it returned: which tools it called and with what, whether it tried a write, what it answered. The recording has every call, in replays too, so these assertions cost nothing.

```python
@pytest.mark.shadowlap
def test_refund(shadowlap_recording):
    run_agent("refund order A-1042")
    assert shadowlap_recording.called("issue_refund", order_id="A-1042") == 1
    assert shadowlap_recording.called("send_email") == 0
    assert "refund issued" in shadowlap_recording.answer()
```

```ts
import { currentRecording, recorded } from '@shadowlap/test';

test('refunds the order', recorded(async () => {
  await runAgent('refund order A-1042');
  const rec = currentRecording();
  expect(await rec.called('issue_refund', { order_id: 'A-1042' })).toBe(1);
  expect(await rec.called('send_email')).toBe(0);
  expect(await rec.answer()).toContain('refund issued');
}));
```

With `recording()` in Python, the context manager gives the same object (`with recording(path) as rec:`), and `withRecording` passes it to its function.

| Python | TypeScript | Returns |
|---|---|---|
| `called(name, **args)` | `called(name, args?)` | How many times the tool was called; with arguments, only calls whose arguments contain those values (nested objects match partially) |
| `tool_calls(name=None)` | `toolCalls(name?)` | Tool calls, with `args`, `result` or `error`, and `origin` |
| `calls()` | `calls()` | Every call in order: model calls (with `model`), tool calls, clock and random reads, each with `kind`, `name`, `origin`, `outcome` and `scope` |
| `answer()` | `answer()` | The text of the last model response, or `None`/`null` before one |

Tool calls include those blocked after a fork (`origin` is `blocked`), so `called("send_email") == 0` fails when the agent tried. [HTTP hosts recorded as tools](./sdk.md#http-services-without-wrapping) are named `METHOD host/path`. The same checks can live in the config for `shadowlap test`, as [outcome checks](./ci.md#outcome-checks).

## Modes

`SHADOWLAP_RECORD` (or pytest's `--shadowlap-record`) decides what happens:

| Mode | A test with a recording | A test without one |
|---|---|---|
| `missing` (default) | Replays it | Records one |
| `all` | Records it again | Records one |
| `none` (default when `CI` is set) | Replays it | Fails: no model is called in CI |

A recording is saved only when the test passes, so a broken run never becomes the reference. A test that makes no model or tool call saves nothing and says so.

## When a replay diverges

A replay is offline. When a test sends a request its recording doesn't have, the call fails, and the test fails with the divergence rather than whatever error the agent raised next:

```
ShadowlapReplayDiverged: diverged from its recording at call 1 (tool lookup)

✗ Diverged at call 1 (tool lookup): 0 calls replayed before divergence
  ~ $.args.topic
      - "hello"
      + "goodbye"

If the change is intended, record the test again with SHADOWLAP_RECORD=all. To inspect the replay: shadowlap dashboard 01M2R0QYWC…
```

- **Intended change:** record again with `SHADOWLAP_RECORD=all`, and review the new recording in the pull request. (A golden that `shadowlap test` replays is updated with [`shadowlap test --update`](./ci.md#update-a-golden-after-an-intended-change) instead.)
- **An id or another value made on every run**: add the [normalizer](./normalizers-and-redaction.md) the report suggests. It applies to every recording, old ones included. Today's date needs none: dates near a run's start already match.
- **To look closer:** the diverged replay stays in the local store, so `shadowlap dashboard <run>` opens it next to its recording. Clean replays are not kept.

## How it works

The plugin starts `shadowlap serve --recordings` once per test process (per Vitest run), in the project directory. Model calls reach it the same way they do under `shadowlap run`: base-URL variables for clients created after it starts, and [in-process capture](./providers.md#in-process-capture) for everything else, including clients created when a module is imported. Each test worker has a slot in those URLs, and each test's run takes over its worker's slot while the test runs.

- Tool calls go through the Shadowlap SDK as usual, so wrap tools with `tool()` or an [adapter](./frameworks.md). Tools that aren't wrapped run for real on every replay.
- `shadowlap.config.json` applies: normalizers when matching, and redaction rules when a recording is saved.
- Recordings are packs, the same format as `shadowlap pack`, so `shadowlap test` and `shadowlap unpack` read them. They still belong to their test runner, which replays them with the test's own assertions: the [test history](./ci.md#test-history) that `shadowlap test` keeps covers the project's goldens, the packs in `goldens/` and those named under `tests` in the config.
- Running the whole test suite under `shadowlap run` or `shadowlap replay` turns the plugin off; that run records everything.
- The plugins need the `shadowlap` CLI. The Vitest and node:test plugin runs the one `@shadowlap/test` depends on (installed from a clone, the clone's own); pytest runs `shadowlap` from your `PATH`, or through `npx`. `SHADOWLAP_CLI` names another for either.
- Tests that run concurrently inside one worker (`test.concurrent`, `pytest-asyncio` tasks sharing a loop) share its slot, so their calls can't be told apart. Run recorded tests one at a time per worker.

## Another test runner

The plugins here are clients of one small HTTP API on `shadowlap serve --recordings`, specified in
**[the recordings protocol](./recordings-protocol.md)**: the handshake, slots for parallel workers,
the three endpoints, and what happens to a recording when a test passes or fails. Anything that can
spawn a process and make an HTTP request can integrate — JUnit, Go's `testing`, RSpec, Playwright.
