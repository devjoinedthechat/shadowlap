# SDK conformance suite

Seventeen scenarios every Shadowlap SDK must pass, run against a real sidecar on an in-memory store.
No API keys, no network, no model calls: only tools, the clock and randomness.

The protocol being tested is specified in [docs/protocol.md](../../docs/protocol.md).

```sh
npm install && npm run build          # at the repository root, first
node --test --test-reporter=spec testing/conformance/conformance.test.mjs
```

That runs the TypeScript and Python SDKs. A Python 3 on the path is enough for the Python half
(`SHADOWLAP_PYTHON`, else `python3`, else `python`, as on Windows); it is skipped if there is none.

## What is covered

| Scenario | What a failure means |
|---|---|
| `live-ok` | A recorded tool call runs for real and is completed with its result. |
| `live-error` | A throwing tool is still completed, with `outcome: "error"`, and the error reaches the caller. |
| `replay-ok` | A replayed call returns the recorded result **and never runs the implementation**. |
| `replay-error` | A recorded error is raised again as a distinct replayed-error type. |
| `clock-random` | Clock and randomness resolve in one round trip and replay to the same values. |
| `scope` | Parallel branches keep their own answers. Failing here means a client that silently swaps recorded results between sub-agents. |
| `blocked` | A write tool after a fork raises write-blocked and never runs. |
| `stubbed` | Under `--writes stub` the stub is returned and recorded; the implementation never runs. |
| `inactive` | With no `SHADOWLAP_URL` the wrappers are transparent. |
| `bad-effect` | An invalid effect is rejected locally, before any request. |
| `unserializable-result` | A result that cannot become JSON still completes the call, so the recording has no hole. |
| `impl-hash` | A changed implementation is reported but never changes what a call matches. |
| `reads-after-fork` | With `--reads replay` a read tool is still served from the recording after a fork. |
| `base-scope` | `SHADOWLAP_SCOPE` names the branch of a process, so separate processes keep their own answers. |
| `injected-timeout` | A tool that `--fail-at` times out never runs, and raises the language's timeout error, marked injected. |
| `injected-status` | A tool that `--fail-at` answers with an HTTP status raises an error carrying that status. |
| `injected-error` | A tool that `--fail-at` fails with a message raises an error with exactly that message. |

The suite is checked against a deliberately broken client during development: a client that omits
scope propagation passes every other scenario and fails `scope`.

## Testing a new client

Write a small program in your language that performs one **step** per invocation and prints one JSON
object on stdout. The step name arrives as the last command-line argument; `SHADOWLAP_URL` and
`SHADOWLAP_RUN_ID` arrive in the environment. Anything else the program writes is treated as
diagnostic output, and a non-zero exit is fine as long as the JSON object was printed.

| Step | What the program does | JSON it prints |
|---|---|---|
| `live-ok` | Call a `read` tool `echo(n=1)` whose implementation returns `{"got": 1}` and counts its runs. | `{ result, implRuns, active }` |
| `live-error` | Call a `read` tool `boom()` whose implementation raises `boom`. Catch it. | `{ caught: { name, message, replayed }, implRuns }` |
| `clock-random` | Read the clock, a random float and a uuid. | `{ now, random, uuid }` |
| `scope-record` | In scope `a` call `pick()`, then in scope `b` call `pick()`. The implementation returns the branch it ran in. | `{ a, b }` |
| `scope-replay` | The same two calls **in the opposite order**: `b` first. | `{ a, b }` |
| `write` | Call a `pure` tool `ping()`, then a `write` tool `send(to="ops")` whose implementation returns `"sent"` and whose stub is `"stub"`. Catch write-blocked. | `{ result, implRuns, blocked, tool }` |
| `bad-effect` | Try to declare a tool with effect `"nope"`. | `{ rejected }` |
| `unserializable` | Call a `read` tool `weird()` whose implementation returns something JSON cannot represent (a circular object, an opaque value). Catch it. | `{ raised, implRuns }` |
| `impl-hash-a` | Call a `read` tool `stable(k=1)` returning `"value"`. | `{ result, implRuns }` |
| `impl-hash-b` | The same, with the implementation's **source rewritten** but its behaviour unchanged. | `{ result, implRuns }` |
| `reads` | Call the `pure` tool `ping()`, then a `read` tool `fetchit(q="x")` returning `"from-impl"`. | `{ result, implRuns }` |
| `base-scope` | Read the current scope, call `echo(n=1)`, then inside `scope("inner")` read it again and call `echo(n=2)`. Run with `SHADOWLAP_SCOPE` set. | `{ scopes: [outer, inner] }` |
| `fail` | Call `echo(n=1)` and catch what it raises. `timeout` is whether the error is the language's timeout error, `status` the HTTP status it carries or null. | `{ result, caught: { name, message, injected, timeout, status }, implRuns }` |

`implRuns` counts how many times the step's *main* implementation actually executed — the number
several scenarios assert is zero. `replayed` says whether the caught error was the client's
replayed-error type rather than the original class.

Then run the suite against it:

```js
import { report, runConformance } from './testing/conformance/runner.mjs';

const client = { name: 'go', argv: ['./bin/conformance-agent'], cwd: process.cwd() };
process.exitCode = report(client.name, await runConformance(client)) ? 0 : 1;
```

`client.env` adds environment variables (the Python client uses it for `PYTHONPATH`), and
`runConformance(client, { only: ['scope'] })` runs a subset while you iterate.

## Adding a scenario

Add it to [scenarios.mjs](./scenarios.mjs): a `record` step, an optional `replay` step, optional
`env` for the client,
optional `replayOptions` merged into the replay run (`divergeAt`, `writes`, `liveTools`,
`overrides`, `toolFailures`), and a `check` that throws. Then implement the step in both reference clients, or the
suite will fail for the one you skipped — which is the point.
