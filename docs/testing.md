# Test suites

Tests that call a model are slow, cost tokens, and don't give the same answer twice. Mark a test, and Shadowlap records its model and tool calls the first time it runs and replays them after that: offline, instantly, and with the same answers every time. When a code change makes the test send a different request, the test fails with the diff.

It works like vcrpy or Polly.js, with Shadowlap's matching (calls are matched by what they ask, not the order they arrive), its tool effects (a replay never runs a write again) and its reports.

| Runner | Set up | Mark a test |
|---|---|---|
| [pytest](#pytest) | `pip install shadowlap` | `@pytest.mark.shadowlap` |
| [Vitest](#vitest) | `@shadowlap/test`, with its global setup and setup file | `recorded()` |
| [Jest](#jest) | `@shadowlap/test`, with its global setup, teardown and test environment | `recorded()` |
| [node:test](#nodetest) | `--import @shadowlap/test/register` | `withRecording()` |
| [Another runner](#another-test-runner) | The recordings protocol | — |

## pytest

Install the Python package. The plugin loads itself and does nothing for tests without the marker. It works with pytest 6.2 and later, with any pluggy that pytest allows.

```sh
pip install shadowlap
```

```python
import pytest

@pytest.mark.shadowlap
def test_triage():
    result = run_agent("triage the inbox")
    assert len(result.tickets) == 3
```

The recording goes next to the test. Commit it.

| Test              | Its recording                                           |
|-------------------|---------------------------------------------------------|
| A test function   | `__recordings__/test_agent/test_triage/`                |
| A test in a class | `__recordings__/test_agent/TestTriage/test_happy_path/` |

`@pytest.mark.shadowlap(recording="path")` puts it somewhere else. Parametrized tests get one recording per case, and pytest-xdist works: each worker gets its own slot.

Every test gets a recording of its own. A name is cut at 120 characters. A name that was cut, or that would land on another test's recording, ends in the first 8 hex digits of the SHA-256 of the test's name within its file. Two cases that differ only in punctuation, such as `balance?` and `balance!`, would land on one: `test_short[balance!]` gives `test_short-balance-e33869db`.

A recording an earlier version saved without the class folder or the hash is still used by the test that made it.

### Other Python test runners

Other runners can use the context manager the plugin is built on:

```python
from shadowlap.testing import recording

with recording("tests/__recordings__/triage"):
    result = run_agent("triage the inbox")
```

## Vitest

Install `@shadowlap/test` as a dev dependency:

```sh
npm install -D @shadowlap/test
```

Add its setup:

```js
// vitest.config.ts
export default defineConfig({
  test: {
    globalSetup: ['@shadowlap/test/global-setup'],
    setupFiles: ['@shadowlap/test/setup'],
  },
});
```

Wrap each test that calls a model in `recorded()`:

```ts
import { recorded } from '@shadowlap/test';

test('triages the inbox', recorded(async () => {
  const result = await runAgent('triage the inbox');
  expect(result.tickets).toHaveLength(3);
}));
```

The recording is named after the test, including its `describe` blocks, and lives in `__recordings__/<file>/` beside the test file. As with pytest, a name longer than 120 characters, or one that would land on another test's recording, ends in a short hash of the test's full name. `recorded(fn, { recording: 'path' })` overrides that.

Test files that run in parallel workers each get their own slot. A test not wrapped with `recorded()` is left alone: it calls its model and tools directly, whatever ran before it.

## Jest

Install `@shadowlap/test` as a dev dependency, and give Jest its global setup and teardown and its test environment:

```js
// jest.config.js
module.exports = {
  globalSetup: '@shadowlap/test/jest/global-setup',
  globalTeardown: '@shadowlap/test/jest/global-teardown',
  testEnvironment: '@shadowlap/test/jest/environment',
};
```

```js
const { recorded } = require('@shadowlap/test');

test('triages the inbox', recorded(async () => {
  const result = await runAgent('triage the inbox');
  expect(result.tickets).toHaveLength(3);
}));
```

It works as with Vitest: one recording per test, beside the test file and named after the test and its `describe` blocks, the same modes, `currentRecording()`, and a slot for each of Jest's workers.

### Why Jest needs its test environment

Jest runs every test file in a sandbox with globals of its own and a copy of the environment. So the test environment, Jest's Node environment, makes the worker ready in its place:

- it points the worker at its slot;
- it loads in-process capture there;
- it hands the sandbox capture's switch, the store scopes travel in and the `fetch` capture wraps.

A client a module made when it was imported is recorded too.

### CommonJS and ES modules

Test files written as CommonJS, Jest's default, load the CommonJS copies that `@shadowlap/test`, `@shadowlap/sdk` and `@shadowlap/adapters` ship beside their ES modules. Jest can't require an ES module on Node 22. With Jest's ES module support (`--experimental-vm-modules`), they load the ES modules.

A file that needs another test environment (`jsdom`) names it in its docblock, and runs without recordings.

## node:test

Run the tests with the plugin registered:

```sh
node --import @shadowlap/test/register --test
```

Wrap each test that calls a model in `withRecording`:

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

With `recording()` in Python, the context manager gives the same object (`with recording(path) as rec:`), and `withRecording` passes it to its function. The object has these methods:

| Python | TypeScript | Returns |
|---|---|---|
| `called(name, **args)` | `called(name, args?)` | How many times the tool was called; with arguments, only calls whose arguments contain those values (nested objects match partially) |
| `tool_calls(name=None)` | `toolCalls(name?)` | Tool calls, with `args`, `result` or `error`, and `origin` |
| `calls()` | `calls()` | Every call in order: model calls (with `model`), tool calls, clock and random reads, each with `kind`, `name`, `origin`, `outcome` and `scope` |
| `answer()` | `answer()` | The text of the last model response, or `None`/`null` before one |

Tool calls include those blocked after a fork (`origin` is `blocked`), so `called("send_email") == 0` fails when the agent tried. [HTTP hosts recorded as tools](./sdk.md#http-services-without-wrapping) are named `METHOD host/path`. The same checks can live in the config for `shadowlap test`, as [outcome checks](./ci.md#outcome-checks).

## Modes

`SHADOWLAP_RECORD` (or pytest's `--shadowlap-record`) decides what happens:

| Mode                              | A test with a recording | A test without one              |
|-----------------------------------|-------------------------|---------------------------------|
| `missing` (default)               | Replays it              | Records one                     |
| `all`                             | Records it again        | Records one                     |
| `none` (default when `CI` is set) | Replays it              | Fails: no model is called in CI |

A recording is saved only when the test passes, so a broken run never becomes the reference. A test that makes no model or tool call saves nothing and says so.

## When a replay diverges

A replay is offline. When a test sends a request its recording doesn't have, the call fails, and the test fails with the divergence rather than whatever error the agent raised next:

```text
ShadowlapReplayDiverged: diverged from its recording at call 1 (tool lookup)

✗ Diverged at call 1 (tool lookup): 0 calls replayed before divergence
  ~ $.args.topic
      - "hello"
      + "goodbye"

If the change is intended, record the test again with SHADOWLAP_RECORD=all. To inspect the replay: shadowlap dashboard 01M2R0QYWC…
```

- **Intended change:** record again with `SHADOWLAP_RECORD=all`, and review the recording it makes in the pull request. (A golden that `shadowlap test` replays is updated with [`shadowlap test --update`](./ci.md#update-a-golden-after-an-intended-change) instead.)
- **An id or another value made on every run:** add the [normalizer](./normalizers-and-redaction.md) the report suggests. It applies to every recording, old ones included. Today's date needs none: dates near a run's start already match.
- **To look closer:** the diverged replay stays in the local store, so `shadowlap dashboard <run>` opens it next to its recording. Clean replays are not kept.

## How it works

The plugin starts `shadowlap serve --recordings` once per test process (per Vitest or Jest run), in the project directory. Model calls reach it the same way they do under `shadowlap run`:

- **Base-URL variables**, for clients created during a recorded test.
- **[In-process capture](./providers.md#in-process-capture)**, for everything else, including clients created when a module is imported. Capture also takes calls to the base URLs the suite had, so a client made from them is recorded too.

Each test worker has a slot in those URLs, and each test's run takes over its worker's slot while the test runs.

### Keys

A replay needs no key. While a recorded test replays, each key variable of a provider its recording called that the environment leaves empty holds a [placeholder](./how-it-works.md#keys), `shadowlap-offline-replay-placeholder`. So a client the test builds the default way (`new Anthropic()`, `openai.OpenAI()`, `genai.Client()`) sends what the recording answers, in CI with no secrets too. The variable is back as it was once the test ends.

A client built when a module is imported reads its key before any test runs: build it in the test or a fixture, or give the job any value for its key.

### Only while a recorded test runs

All of that holds only while a recorded test runs, in both plugins. The base-URL variables and `SHADOWLAP_URL` point at the slot from the start of the recording to its end, and capture is off outside it.

A test without the marker, or not wrapped with `recorded()`, sees the environment it had and calls its model and tools directly, whether or not a recorded test ran before it. A client created while a recorded test runs keeps pointing at Shadowlap afterwards, so don't hand one from a recorded test to a test without a recording.

### Tools that aren't recorded

Tool calls go through the Shadowlap SDK as usual, so wrap tools with `tool()` or an [adapter](./frameworks.md). A tool that isn't wrapped runs for real on every replay. So a recording whose model called one that [writes, or may](./how-it-works.md#tools-shadowlap-did-not-record), is refused before its replay starts, as every command that replays a run refuses it. The test fails with the tool named and how to have it recorded.

If running it again is safe, declare it a read under `tools.unrecorded` in the config, or name it in `SHADOWLAP_ALLOW_UNRECORDED` for the test run. The plugin's `shadowlap serve --recordings` reads that as `--allow-unrecorded`:

```sh
SHADOWLAP_ALLOW_UNRECORDED=Bash pytest
```

### Recordings and the config

- **The config applies:** `shadowlap.config.json` gives its normalizers when matching, and its redaction rules when a recording is saved.
- **Recordings are packs**, the same format as `shadowlap pack`, so `shadowlap test` and `shadowlap unpack` read them.
- **A test replays its own recording.** A recording folder copied to another test and changed by hand, whose run id the store already holds with other calls, is refused, saying where the store's copy came from.
- **Recordings belong to their test runner**, which replays them with the test's own assertions. The [test history](./ci.md#test-history) that `shadowlap test` keeps covers the project's goldens: the packs in `goldens/` and those named under `tests` in the config.
- **Running the whole test suite** under `shadowlap run` or `shadowlap replay` turns the plugin off; that run records everything.

### The CLI the plugins run

The plugins need the `shadowlap` CLI:

| Plugin | The CLI it runs |
|---|---|
| Vitest, Jest and node:test | The one `@shadowlap/test` depends on |
| pytest | `shadowlap` from your `PATH`, which `pip install shadowlap` provides: the [command](./sdk.md#install) that runs the npm CLI at the Python package's version |

`SHADOWLAP_CLI` names another for either.

### One test at a time per worker

Tests that run concurrently inside one worker (`test.concurrent`, `pytest-asyncio` tasks sharing a loop) share its slot, so their calls can't be told apart. Run recorded tests one at a time per worker.

## Tests that fork

A recorded test replays offline and comes out the same every time, so one run settles it. A golden that `shadowlap test` lets fork is different: everything after its fork runs live, so it is a sample. Its `gate` decides on attempts as they come in, with the error rates it states.

A test session of gated goldens:

- splits one risk of going red for nothing across its gated goldens;
- says what it will cost before it runs;
- keeps a golden's baseline to sessions that passed on the default branch outside a pull request;
- never lets a provider error decide a verdict: an attempt the provider failed before the model answered is run again and never counted, and one it cut short after is counted against either verdict.

Its figures take a golden's attempts to be independent of each other, so the goldens' attempts run in turns: the first of each, then the second of each still open. Failures that come in a burst, a slow minute at the provider or a shared service down, land on many goldens once each rather than on one golden's attempts in a row. An agent that keeps state from one run to the next (a cache it fills, a file it leaves) breaks that on its own, and turns can't help.

A golden gated against its own history needs sessions to tell a drop from chance. While it has fewer than 30, its gate running out of attempts only warns, its line saying it needs more history (`needs more history: 3 of 30 sessions`). That holds unless `--inconclusive fail` counts it or the plan reads a decline or a drop in its sessions, and a clear failure still fails. A gate on two fixed rates, `"good"` and `"bad"`, needs no history at all.

[Gating](./gating.md#attempts-are-independent) has the rules and the proof of each figure.

## Another test runner

The plugins here are clients of one small HTTP API on `shadowlap serve --recordings`, specified in [the recordings protocol](./recording-format.md#the-recordings-protocol): the handshake, slots for parallel workers, the three endpoints, and what happens to a recording when a test passes or fails. Anything that can spawn a process and make an HTTP request can integrate: JUnit, Go's `testing`, RSpec, Playwright.

## Environment variables

The variables the plugins read or set:

| Variable | What it does | Default |
|---|---|---|
| `SHADOWLAP_RECORD` | The [mode](#modes): `missing`, `all` or `none` | `missing`, or `none` when `CI` is set |
| `SHADOWLAP_ALLOW_UNRECORDED` | Tools to run again on a replay, read as `--allow-unrecorded` | — |
| `SHADOWLAP_CLI` | Another `shadowlap` CLI for either plugin | — |
| `SHADOWLAP_URL` | Set by the plugin to the worker's slot while a recorded test runs | — |

## See also

- [CI mode](./ci.md): goldens, `shadowlap test` and the test history.
- [Gating](./gating.md): goldens that fork, decided by a gate.
- [The recording format](./recording-format.md): what a recording holds, and the recordings protocol.
- [SDK](./sdk.md): wrapping tools so a replay never runs a write again.
