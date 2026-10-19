# The recordings protocol

Shadowlap's pytest, Vitest and node:test integrations are clients of one small HTTP API on
`shadowlap serve --recordings`. This page specifies it, so that an integration can be written for a
test runner Shadowlap does not ship — JUnit, Go's `testing`, RSpec, Playwright, anything that can
spawn a process and make an HTTP request.

It is a different API from [the SDK wire protocol](./protocol.md), and both are needed for a full
integration: this one decides *which recording a test uses and what happens to it*, while the wire
protocol carries the individual tool, clock and randomness calls. The recordings it keeps are packs,
as [the recording format](./recording-format.md) specifies them.

What a [recorded test](./testing.md) does is record its agent's calls the first time it runs and
replay them offline afterwards: fast, free and deterministic, failing with a diff when a code change
alters a request.

## The handshake

The host is started by the plugin, once per test-runner **worker process**, and lives as long as
that process does.

1. Spawn `shadowlap serve --recordings` with the project root as its working directory, and with
   **stdout and stdin both piped**.
2. Read **one line** of JSON from its stdout:

```json
{
  "shadowlap": "0.1.0",
  "url": "http://127.0.0.1:53211/t/9f2c…",
  "root": "/path/to/project",
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:53211/t/9f2c…/s/__SLOT__/anthropic", "SHADOWLAP_CAPTURE": "…" },
  "capture": { "node": "/…/guard/node-capture.mjs", "python": "/…/guard" }
}
```

3. In every value of `env`, replace the literal `__SLOT__` with this worker's [slot](#slots), then
   set those variables in the test process **before** any model SDK or capture module loads. These
   are what point the provider SDKs at the host.
4. Load the capture module for your language from `capture` — `capture.node` is a file to
   `--import`, `capture.python` is a directory to put on `sys.path` before importing
   `_shadowlap_capture`. It patches clients that cannot be redirected by a base URL. Skip this and
   `fetch`/`httpx`-level calls and signed clients (Bedrock, Vertex, Azure) go unrecorded.

   A call that reaches a slot no recording holds is refused with `409`. So a runner whose tests
   don't all have a recording sets the variables only from `start` to `end` and then puts back what
   they were, and turns capture off in between (the Python module's `active = False`; in Node,
   `globalThis[Symbol.for('shadowlap.capture')].active = false`), as the pytest and Vitest plugins do. Capture reads its configuration when it loads, so load it with the variables set.
5. **Keep stdin open.** The host runs until its stdin closes, which is how it shuts down when the
   runner exits. Closing stdin (or `SIGINT`/`SIGTERM`) is the only stop signal; there is no endpoint
   for it.

Treat `url` as opaque: it carries a session token as a path segment, and it is a credential, so do
not log it.

## Slots

A slot is a short name for one parallel worker, so that several workers share one host without
taking each other's runs. Derive it from the runner's worker id — pytest-xdist's
`PYTEST_XDIST_WORKER`, a Vitest worker index — falling back to `main` when the runner is
single-process. Keep it to letters, digits, `_`, `.` and `-`, at most 64 characters.

The same slot goes in the `__SLOT__` substitution and in the `slot` field of `start`.

## Endpoints

Every request is `POST` with a JSON body and `content-type: application/json`. On a non-2xx response
the body is `{"error": {"message": "…"}}`.

### `POST /v1/recordings/start`

Call it when a test starts, before the agent runs.

```json
{ "recording": "tests/recordings/refund-flow", "slot": "gw0", "mode": "missing", "name": "test_refund_flow", "command": ["pytest", "-k", "refund"] }
```

| Field | Required | Notes |
|---|---|---|
| `recording` | yes | The recording's directory. Absolute, or relative to the project root. It **must** resolve inside the root; anything else is a 400. |
| `slot` | yes | This worker's slot. |
| `mode` | no | `missing` (default): replay when a recording exists, record when it does not. `all`: always record. `none`: only replay, and fail when there is nothing to replay. |
| `name` | no | The test's name, used in the run's command line when none is given. |
| `command` | no | The command to record as the run's own, for `shadowlap replay` later. Without one the run records `<test>` and the test's name, and has no command to run again: replaying it, finding its commit or forking it needs yours after `--`, as for a capture. |

```json
{ "runId": "01K5CQ4N7G…", "mode": "record", "recording": "tests/recordings/refund-flow" }
```

`mode` in the response is what actually happened, which is what the test should report. A `none`
mode with no recording on disk is a 404 whose message says how to record it.

Starting a run in a slot ends whatever was still running in that slot, so a crashed test does not
wedge the worker.

### `POST /v1/recordings/calls`

Optional, and what makes assertions possible. Call it any time while the run is in progress, as
often as you like.

```json
{ "runId": "01K5CQ4N7G…" }
```

```json
{
  "answer": "Refunded order 1182.",
  "calls": [
    { "callNo": 1, "kind": "api", "name": "POST /v1/messages", "origin": "replayed", "outcome": "ok", "model": "claude-haiku-4-5" },
    { "callNo": 2, "kind": "tool", "name": "send_email", "origin": "blocked", "outcome": "error", "args": { "to": "x@y" }, "error": { "name": "ShadowlapWriteBlocked", "message": "…" } }
  ]
}
```

`answer` is the text of the last model response, or `null` before there is one. `outcome` is `null`
while a call is still in flight. `args`, `result` and `error` appear for tool calls only, exactly as
the agent saw them; `scope` appears when the call was made inside one. Expose these to the test —
"`send_email` was never called" is the assertion people actually want.

### `POST /v1/recordings/end`

Call it exactly once per `start`, whatever the test's outcome.

```json
{ "runId": "01K5CQ4N7G…", "passed": true }
```

`passed` is the test's own result, and it decides what happens next:

| Mode | `passed` | What the host does |
|---|---|---|
| record | `true` | Packs the run into the recording directory, atomically (written beside it and swapped in, so an interrupted write never leaves half a pack). Redaction rules from `shadowlap.config.json` are applied. |
| record | `false` | Saves nothing: a failing test should not become the golden. |
| record | either, no calls | Saves nothing, and says so — usually a base URL that was never redirected. |
| replay | — | A clean replay is deleted, since it adds nothing. A divergence is kept in the local store to inspect. So is a replay that ended early: every request the test sent matched, but it stopped before making every recorded model or tool call, so it fails with `ended early at call 13 (api POST /v1/messages): 12 of 30 recorded calls replayed`. |

```json
{
  "ok": false,
  "mode": "replay",
  "runId": "01K5CQ4N7G…",
  "recording": "tests/recordings/refund-flow",
  "calls": 30,
  "replayed": 12,
  "message": "diverged from its recording at call 13 (api POST /v1/messages)",
  "report": "…the divergence report and run summary, ready to print…"
}
```

**`ok` is the verdict the test should fail on.** `message` is one line for a test-runner summary;
`report` is the multi-line diff and summary to print in full. On a record that saved, `saved` is
`true` and both are `null`.

## Choosing the mode

The default that makes recorded tests pleasant: read an explicit setting from the environment
(`SHADOWLAP_RECORD`), and otherwise use `none` when `CI` is set and `missing` when it is not. So a
developer's first run records, later runs replay, and CI never records — a missing recording fails
the build instead of quietly making one.

## Checklist for a new integration

1. Spawn the host once per worker; read its JSON line; substitute `__SLOT__`; set the env before anything else loads.
2. Load the capture module for your language.
3. Keep stdin open for the life of the worker.
4. `start` per test, with the recording directory and the slot.
5. `end` per test with the real `passed`, exactly once, even when the test errored.
6. Fail the test when `ok` is false, printing `report`.
7. Expose `calls` and `answer` to the test for assertions.
8. Pick the mode from the environment, defaulting to `none` under CI.

## Versioning

`shadowlap` in the handshake is the CLI's version. The protocol is pre-1.0 and may change; there is
no negotiation yet. An integration should check that the version it reads is one it knows, and say
so plainly rather than failing on a missing field.
