# The SDK wire protocol

Shadowlap's SDKs are thin clients of one small HTTP API on the sidecar. This page specifies it
completely, so that an SDK can be written for a language Shadowlap does not ship.

Model API calls need none of this: they are captured by pointing the provider SDK at the sidecar
through its base URL, which works in any language already. This protocol is only for the things a
provider SDK cannot see — **tool calls**, and reads of the **clock** and **randomness**.

A client that implements this page should pass the [conformance suite](https://github.com/devjoinedthechat/shadowlap/tree/main/testing/conformance),
which runs against a real sidecar and needs no API keys.

> **Normative language.** MUST, SHOULD and MAY carry their usual weight. Where this page settles a
> question the shipped SDKs answered differently, it says so.

## Discovery

Two environment variables, set by `shadowlap run` and `shadowlap replay` for the agent process:

| Variable | Meaning |
|---|---|
| `SHADOWLAP_URL` | Base URL of the sidecar, including a session token path. Absent means Shadowlap is not running. |
| `SHADOWLAP_RUN_ID` | The run these calls belong to. |
| `SHADOWLAP_SCOPE` | Optional. The [scope](#scopes) this process starts in, for an agent whose branches are separate processes. A client reads it as the initial scope, and scopes entered in code nest underneath. |
| `SHADOWLAP_STDIN` | Optional. The input `shadowlap` was given, as `dev:ino` (unsigned). A client that records what a person types reads it from that input only, a terminal, or the null device (see [User input](#user-input)). On Windows only a file has one: `dev` is its volume's 32-bit serial number and `ino` its 64-bit file id. |

A client MUST treat `SHADOWLAP_URL` as opaque: it already contains the session token as a path
segment (`http://127.0.0.1:PORT/t/<token>`), and the sidecar rejects any request that does not carry
it. Strip a trailing `/`, append the endpoint paths below, and change nothing else. Because the token
is a credential, a client MUST NOT log the URL or include it in an error message.

**When `SHADOWLAP_URL` is unset, the client MUST do nothing**: call the real tool, read the real
clock, return the real random value. A wrapped tool outside Shadowlap must behave exactly like the
function it wraps. This is what makes it safe to leave the wrappers in production code.

`SHADOWLAP_RUN_ID` MAY be absent when the sidecar serves a single run. Send it when it is present.

## Transport

Every request is `POST` with a JSON body and `content-type: application/json`. Responses are JSON.

| Header | When |
|---|---|
| `content-type: application/json` | Always. |
| `x-shadowlap-run: <run id>` | Whenever `SHADOWLAP_RUN_ID` is set. |
| `x-shadowlap-scope: <scope>` | When the calling context is inside a scope, `%` and anything outside printable ASCII percent-encoded. See [Scopes](#scopes). |
| `user-agent` | SHOULD name the language, e.g. `shadowlap-go/0.1`. The sidecar buckets clients by this for telemetry only; it never affects behavior. |
| `x-shadowlap-sdk: <language>/<version>` | SHOULD name the client and its release, e.g. `go/0.1.0`. The official SDKs send `node/<version>` and `python/<version>` on every call. A run's summary names an SDK whose major.minor differs from the sidecar's, once; the header never changes how a call is answered. |

There is no authentication header. The token in the path is the whole of it.

**Never through a proxy.** The sidecar is on the machine's loopback. A client MUST reach it
directly, whatever proxy the environment names (`HTTP_PROXY`, a system proxy): through a proxy, the
call would cross the network in clear text with the session token in its URL, and the proxy can't
reach the loopback anyway. Both SDKs open the sidecar with proxies turned off, whatever the agent
sets up for its own traffic: the Python SDK with a urllib opener that has no proxy handler, the
TypeScript SDK with `node:http` and an agent of its own rather than `fetch`, whose dispatcher an
agent may route through a proxy (undici's `ProxyAgent` ignores `NO_PROXY`). `shadowlap run` adds
`127.0.0.1`, `localhost` and `::1` to `NO_PROXY` and `no_proxy` for the agent, for the clients
that read them.

**Timeouts.** A client SHOULD apply a request timeout of about 30 seconds. The sidecar answers
`resolve` and `complete` locally and does not wait on the network, so a slow response means it is
wedged, not busy.

**Failure is fatal.** If the sidecar is unreachable, times out, or answers with a status outside
2xx, the client MUST propagate the failure to the caller. It MUST NOT fall back to executing the
tool. Falling back would run a side effect the run was meant to replay, and would leave a hole in
the recording — the two failures Shadowlap exists to prevent.

On a non-2xx response the body is `{"error": {"message": "..."}}`. A client SHOULD surface that
message.

## Endpoints

### `POST /v1/calls/resolve`

Asks the sidecar what to do about a call that is *about to happen*. Send it before running anything.

**A tool call:**

```json
{ "kind": "tool", "name": "search_web", "effect": "read", "args": { "query": "…" }, "implHash": "…" }
```

| Field | Required | Notes |
|---|---|---|
| `kind` | yes | `"tool"` |
| `name` | yes | Non-empty. Part of the call's identity. |
| `effect` | yes | `"pure"`, `"read"` or `"write"`. The sidecar rejects anything else with 400. |
| `args` | yes | The arguments as JSON. `null` if there are none. Part of the call's identity. |
| `implHash` | no | Any stable hash of the implementation's source. Never part of matching; it only powers the "this tool changed since the recording" warning. |
| `trust` | no | `"untrusted"` for a read that brings outside text in (a page, an email), where `shadowlap injection` plants payloads; stored as the call's `meta.trust`, with `meta.trustFrom` `sdk` (`mcp` for a call through `shadowlap mcp`). `"trusted"` (the default) is stored as nothing. A tool the config's `tools` names is stored with the config's word instead, either way, and `meta.trustFrom` `config`. Never part of matching. |

`effect` has no default, by design. The only safe default would be `write`, and making that
implicit would hide a decision the developer has to make. A client MUST require it and SHOULD
reject a bad value locally, before any request.

**A clock or randomness read:**

```json
{ "kind": "clock",  "name": "now",              "label": "" }
{ "kind": "random", "name": "random" | "uuid",  "label": "" }
```

`label` disambiguates concurrent reads of the same kind; it is part of the call's identity. Send
`""` when there is none. These resolve in one round trip — the sidecar generates the value and
records it, so there is no `complete` for them.

**The response** is one of seven shapes. `callNo` identifies the call for `complete`.

| `origin` | Shape | What the client does |
|---|---|---|
| `replayed` | `{ origin, callNo, outcome: "ok", result }` | Return `result`. **Do not run the implementation.** |
| `replayed` | `{ origin, callNo, outcome: "error", error }` | Raise the recorded error (see below). **Do not run the implementation.** |
| `replayed` | `{ origin, callNo, outcome: "error", error, injected }` | Raise the failure `--fail-at` asked for, as the kind `injected` names (see [Injected failures](#injected-failures)). **Do not run the implementation.** No `complete`. |
| `live` | `{ origin, callNo, outcome: "ok", result }` | Clock and randomness only: return `result`. No `complete`. |
| `live` | `{ origin, callNo }` | Tools: run the implementation, then `complete`. |
| `blocked` | `{ origin, callNo, outcome: "error", error }` | Raise a write-blocked error. **Do not run the implementation.** No `complete`. |
| `stubbed` | `{ origin, callNo }` | Do not run the implementation. Produce the stub value (see below) and `complete` with it. |

A client MUST treat an unknown `origin` as an error rather than guessing.

`blocked` and `stubbed` happen only after a fork, and only for `write` tools. `blocked` is the
default; `--writes stub` produces `stubbed` instead.

### `POST /v1/calls/{callNo}/complete`

Reports what a `live` or `stubbed` tool call did. Exactly once per such call. Numbers in `result`
(and in a resolve call's `args`) are kept as the client wrote them: a replay serves `20.0` and
`1234567890123456789` back with the same digits. In `args`, an integer past 2^53 matches by its
exact digits, and a divergence report shows it as its digits in a string; any other number matches
by the value it reads as, so `20.0` matches `20`.

```json
{ "outcome": "ok",    "result": …,      "latencyMs": 12 }
{ "outcome": "error", "error": { … },   "latencyMs": 12 }
```

| Field | Required | Notes |
|---|---|---|
| `outcome` | yes | Anything other than `"error"` is read as `"ok"`. |
| `result` | on ok | JSON. Send `null` rather than omitting it. |
| `error` | on error | A serialized error (below). |
| `latencyMs` | no | How long the implementation took. Send `0` for a stub. |

The sidecar answers `409` if the call was already completed and `404` if `callNo` is unknown.

**A `live` tool call MUST be completed on both paths** — when it returns and when it throws. A call
left pending is a hole in the recording: the replay has no answer for it. If the result cannot be
turned into JSON, the client MUST complete the call with `outcome: "error"` describing that, and
then raise. Both shipped SDKs do this, and the `unserializable-result` conformance scenario checks it.
A completion the sidecar refuses (a `400`) is the same hole, so a client that fails to send the `ok`
completion SHOULD complete the call with an error before raising.

A call the caller cuts off (Python's `asyncio.wait_for` deadline, a cancelled task) has not
failed: the tool was stopped. The Python SDK completes it with `outcome: "error"`, the error named
`CancelledError` and `data: { "cancelled": true }` (`false` when the tool raised `CancelledError`
from an awaitable of its own). Replaying it, a client MUST NOT raise a replayed error: it waits
until the caller cancels the call again, as its deadline or cancel did when it was recorded, so the
agent takes the same path. An interrupt or an exit inside a tool (`KeyboardInterrupt`,
`SystemExit`) is not the tool's answer either, and leaves the call as the run left it.

JSON has no NaN or Infinity, and the sidecar refuses a body that has them. Both shipped SDKs record
them as `null`, in arguments and results, as `JSON.stringify` does; the caller still gets the
tool's own value while recording, and the `null` on replay (the `non-finite-result` scenario).

### User input

What a person types is input from outside the agent, like a tool's result, and a replay has no one
to type it. A client records it as a read tool named `user_input`, with the prompt as its argument
and `"input": true` on `resolve`:

```json
{ "kind": "tool", "name": "user_input", "effect": "read", "args": { "prompt": "How can I help? " }, "input": true }
```

It completes the call with the answer as `{ "text": "…" }`, without the line ending. When the input
ended (Ctrl-D, a closed pipe) it completes with `outcome: "error"` and an error named `EOFError`, and
raises whatever the language raises at the end of its input. The sidecar stores the call with
`meta.input = true`.

Before a fork, an input call replays like any read. After one there is no one to type, so the
sidecar answers `replayed` with the recorded answers **in the order they were given**, whatever the
prompt now says, until they run out; then it answers `live`. A replay started with `--live-input`
answers `live` after the fork instead. A `replayed` result is `{ "text": … }`, or a bare string when
the run overrides the answer (`--override n='"…"'`); a client accepts both.

Every run the CLI starts an agent for is marked `meta.inputs = true`: what a person typed is part of
what it holds, so an input call a replay of it doesn't find is a change, and the run forks there. A
recording without the mark and without any input call was made before input was recorded; a replay
of it answers its input calls `live` and goes on replaying, rather than forking at the first one.

The shipped clients record this without code changes: Shadowlap's preloads record `input()` and reads
of `sys.stdin` in Python, and readline's `question` and `for await` in Node, on the input `shadowlap`
gave the agent only (a terminal, the null device, or the pipe or file named by `SHADOWLAP_STDIN` as
`dev:ino`). `userInput()` / `user_input()` in the SDKs record input that arrives any other way.

### MCP tool calls

`shadowlap mcp` resolves each `tools/call` it forwards like any tool call, with the server's tool
annotations as its effect, and adds where the call came from:

```json
{ "kind": "tool", "name": "send_note", "effect": "write", "args": { "to": "billing" },
  "mcp": { "transport": "http", "server": "mcp.example.com", "tools": [{ "name": "send_note", "effect": "write" }] } }
```

`transport` is `stdio` or `http`; `server` is the remote server's host, or the local server's
command (with the package a runner such as `npx` starts), never its arguments or a URL's path.
`tools` lists the server's tools with their effects, and `"trust": "untrusted"` for a read whose
server sets `openWorldHint` (the call itself then carries `trust` too), on the first call to that
server in a run and whenever the list changes. The sidecar checks and bounds the object and stores it as `meta.mcp`.

### `POST /v1/guard`

Optional. Reports an outbound connection that bypassed Shadowlap, for the network guard's summary.

```json
{ "target": "api.example.com:443", "action": "blocked" | "warned" }
```

Answers `202`. `target` is truncated to 300 characters; a UDP target is named `udp://host:port`. A
client that does not intercept the network can ignore this endpoint entirely.

### `POST /v1/hello`

Optional. A preload says it loaded in one process of the agent, once, when it has set itself up:

```json
{ "runtime": "node", "runtimeVersion": "22.16.0", "pid": 4242, "ppid": 4241, "guard": "warn" | "block" | "off", "capture": true }
```

Answers `202`, or `409` when the run has ended. The sidecar counts processes by `pid`, so a second
hello from one process (a worker thread's) changes nothing. A run the CLI started its agent for that
made model or tool calls with no hello from any process was never watched by the network guard: its
summary says so, and under `--guard block` it fails. A client that loads no preload sends none. The
sidecar also reads `x-shadowlap-sdk` (`python/0.1.0`) on a hello, as on every `/v1/calls/*` request,
and names an SDK whose major.minor differs from its own once per run.

## Errors

A serialized error is:

```json
{ "name": "TimeoutError", "message": "upstream timed out", "code": "ETIMEDOUT", "data": null }
```

`name` and `message` are required; `code` and `data` are optional. The original class is not
preserved across a replay — only these fields — so a client SHOULD raise a dedicated
"replayed error" type carrying them, rather than trying to reconstruct the original.

Two more optional fields let a replayed error print as the original did, where the language prints
more than the message. `module` is the module that defined the error's class, left out for a
builtin: a traceback names a class by it (`myapp.errors.OrderMissing`). `args` is the list of
arguments the error was made with, left out when it is the message alone or isn't JSON as it is
(a tuple, say): Python's `repr()` prints them (`KeyError('A-17')`, `RuntimeError()`). The Python
SDK records and replays both; a client that doesn't use them ignores them.

```json
{ "name": "FileNotFoundError", "message": "[Errno 2] No such file or directory: 'orders/A-17'", "args": [2, "No such file or directory"] }
```

Two error types every client SHOULD expose, because agent code catches them by name:

- **replayed error** — raised for `replayed` with `outcome: "error"`. Carries `name`, `message`, `code`, `data`. It SHOULD read as the recorded error did: the same text when turned into a string or printed (Python's `str()` and `repr()`, TypeScript's `String()` and `util.inspect()`). Agents hand a tool's error to the model as text, so a replayed error that reads differently changes the next request, and a replay of unchanged code forks. Both SDKs raise an instance of a subclass of their replayed-error type named after the recorded error.
- **write-blocked error** — raised for `blocked`. Carries the tool name and the arguments it was called with, so a handler can report what was prevented.

### Injected failures

`shadowlap replay --fail-at <call>=timeout|error[:message]|<status>` fails a tool call instead of
serving or running it, so the agent's handling of a failing tool runs. The sidecar answers `resolve`
with a replayed error that also carries `injected`, and has already recorded the call:

```json
{ "origin": "replayed", "callNo": 19, "outcome": "error",
  "error": { "name": "TimeoutError", "message": "search_web timed out", "code": "ETIMEDOUT" },
  "injected": { "kind": "timeout" } }
```

The `error` is what a real failure of that kind would carry, and nothing more, because agents hand
errors to the model (an MCP client passes `data` on too) and a model told it is being tested
behaves differently. Only `injected` says otherwise, and only to the client.

`injected` is `{ "kind": "timeout" }`, `{ "kind": "error", "message": "…" }` (the message is
optional) or `{ "kind": "status", "status": 503 }`. A client SHOULD raise an **injected failure**
that looks like the failure it stands for, because the agent's handling of the real one is what is
being tested: for `timeout`, the language's timeout error (`TimeoutError` in Python, an error named
`TimeoutError` with code `ETIMEDOUT` in TypeScript); for `status`, an error that carries the status
the way the language's HTTP clients do (`status_code`, `status`); for `error`, an error with
`error.message`. It SHOULD carry `injected = true`, the tool's name and its arguments, so a test can
tell it from a real failure. The client MUST NOT run the implementation and MUST NOT call `complete`.
A proxy for another protocol answers in that protocol's shape for a failing tool: `shadowlap mcp`
sends the MCP client a tool result with `isError: true` whose text is the message.

A client that does not know `injected` raises its replayed-error type with the same name and
message. That still never runs the tool, which is why the failure travels in this shape: an older
client keeps working, and gets the less specific error.

## Scopes

A scope names the branch of the agent a call was made in: one sub-agent of several running at once.
Repeats are counted **per scope**, so two branches that send the same request at the same time each
get their own recorded answer on replay, in whatever order they arrive.

A client implements this with whatever its language uses for implicit context — `AsyncLocalStorage`
in Node, `contextvars` in Python, a `context.Context` in Go — and sends the current value as
`x-shadowlap-scope` on every request made inside it, for tools, clock, randomness and captured HTTP
alike.

- Scopes nest by joining with `/`: `researcher` inside `team` is `team/researcher`.
- A scope can have any name, and a header holds Latin-1 at most, so a client MUST percent-encode `%` and every character outside printable ASCII (as UTF-8 bytes) before sending it: `東京` is sent as `%E6%9D%B1%E4%BA%AC`, `50% off` as `50%25 off`. `/` and the rest of printable ASCII are sent as they are, so an ASCII name without `%` is unchanged. The sidecar decodes the header, and records the name as it was given; a value that doesn't decode is taken as it was sent. The `scope-names` conformance scenario checks it.
- The sidecar ignores a scope that is empty, longer than 200 characters, or contains control characters. A client SHOULD apply the same limits rather than relying on that.
- Outside Shadowlap, entering a scope MUST still work — it just sets the variable.

**A client that skips scopes is not merely less featureful: it is wrong for parallel agents**, which
will swap each other's recorded answers on replay. Implement scopes or document loudly that the
client is single-branch only.

## Call identity

The client does not compute identity; the sidecar does. It is worth knowing what feeds it, because
it determines what the client must send faithfully:

- **tools** — `name` and `args`, canonicalized and passed through the run's normalizers
- **clock and randomness** — `kind` and `label`

Arrival order is never part of identity. A call is matched by `(kind, fingerprint, occurrence)`,
where occurrence is *n* for the *n*-th identical call in that scope. [The recording
format](./recording-format.md#identity) specifies how a fingerprint is computed. This is why `args` must be
serialized consistently: a client that reorders object keys between runs still matches (the sidecar
canonicalizes), but one that sometimes omits a null field and sometimes includes it does not.

## A complete exchange

A `read` tool during a recording:

```
→ POST /t/<token>/v1/calls/resolve
  x-shadowlap-run: 01K5CQ4N7G
  { "kind": "tool", "name": "search_web", "effect": "read", "args": {"q":"shadowlap"}, "implHash": "9f2…" }
← 200 { "origin": "live", "callNo": 7 }

  … the client runs the real implementation …

→ POST /t/<token>/v1/calls/7/complete
  { "outcome": "ok", "result": {"hits": 3}, "latencyMs": 412 }
← 200 { "ok": true }
```

The same tool during a clean replay:

```
→ POST /t/<token>/v1/calls/resolve
  { "kind": "tool", "name": "search_web", "effect": "read", "args": {"q":"shadowlap"}, "implHash": "9f2…" }
← 200 { "origin": "replayed", "callNo": 7, "outcome": "ok", "result": {"hits": 3} }

  … the client returns {"hits": 3} without calling the implementation …
```

## Checklist for a new client

1. Read `SHADOWLAP_URL` and `SHADOWLAP_RUN_ID`; do nothing at all when the first is unset.
2. A tool wrapper that takes a required effect and rejects a bad one locally.
3. `resolve` before running anything, with `name`, `effect`, `args` and ideally `implHash`.
4. Handle all seven response shapes, an injected failure included; treat an unknown `origin` as an error.
5. `complete` every `live` and `stubbed` call, on both the success and the failure path.
6. One round trip for clock and randomness, with no `complete`.
7. Scope propagation through the language's implicit context, as `x-shadowlap-scope`.
8. A replayed-error type, a write-blocked type, and an injected-failure type.
9. Fail closed: never run the implementation because the sidecar was unreachable.
10. Run the [conformance suite](https://github.com/devjoinedthechat/shadowlap/tree/main/testing/conformance).

## Versioning

This protocol is pre-1.0 and may change. It is the protocol of the release that runs the sidecar,
which `shadowlap --version` reports: a client sends no protocol version, and the sidecar asks for
none. A client names its own release in `x-shadowlap-sdk`, and a run's summary says when an SDK's
major.minor differs from the sidecar's, since an SDK and the CLI work together at the same one.
