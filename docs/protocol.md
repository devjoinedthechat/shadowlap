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
| `x-shadowlap-scope: <scope>` | When the calling context is inside a scope. See [Scopes](#scopes). |
| `user-agent` | SHOULD name the language, e.g. `shadowlap-go/0.1`. The sidecar buckets clients by this for telemetry only; it never affects behavior. |

There is no authentication header. The token in the path is the whole of it.

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

**The response** is one of six shapes. `callNo` identifies the call for `complete`.

| `origin` | Shape | What the client does |
|---|---|---|
| `replayed` | `{ origin, callNo, outcome: "ok", result }` | Return `result`. **Do not run the implementation.** |
| `replayed` | `{ origin, callNo, outcome: "error", error }` | Raise the recorded error (see below). **Do not run the implementation.** |
| `live` | `{ origin, callNo, outcome: "ok", result }` | Clock and randomness only: return `result`. No `complete`. |
| `live` | `{ origin, callNo }` | Tools: run the implementation, then `complete`. |
| `blocked` | `{ origin, callNo, outcome: "error", error }` | Raise a write-blocked error. **Do not run the implementation.** No `complete`. |
| `stubbed` | `{ origin, callNo }` | Do not run the implementation. Produce the stub value (see below) and `complete` with it. |

A client MUST treat an unknown `origin` as an error rather than guessing.

`blocked` and `stubbed` happen only after a fork, and only for `write` tools. `blocked` is the
default; `--writes stub` produces `stubbed` instead.

### `POST /v1/calls/{callNo}/complete`

Reports what a `live` or `stubbed` tool call did. Exactly once per such call.

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

### `POST /v1/guard`

Optional. Reports an outbound connection that bypassed Shadowlap, for the network guard's summary.

```json
{ "target": "api.example.com:443", "action": "blocked" | "warned" }
```

Answers `202`. `target` is truncated to 300 characters. A client that does not intercept the
network can ignore this endpoint entirely.

## Errors

A serialized error is:

```json
{ "name": "TimeoutError", "message": "upstream timed out", "code": "ETIMEDOUT", "data": null }
```

`name` and `message` are required; `code` and `data` are optional. The original class is not
preserved across a replay — only these fields — so a client SHOULD raise a dedicated
"replayed error" type carrying them, rather than trying to reconstruct the original.

Two error types every client SHOULD expose, because agent code catches them by name:

- **replayed error** — raised for `replayed` with `outcome: "error"`. Carries `name`, `message`, `code`, `data`.
- **write-blocked error** — raised for `blocked`. Carries the tool name and the arguments it was called with, so a handler can report what was prevented.

## Scopes

A scope names the branch of the agent a call was made in: one sub-agent of several running at once.
Repeats are counted **per scope**, so two branches that send the same request at the same time each
get their own recorded answer on replay, in whatever order they arrive.

A client implements this with whatever its language uses for implicit context — `AsyncLocalStorage`
in Node, `contextvars` in Python, a `context.Context` in Go — and sends the current value as
`x-shadowlap-scope` on every request made inside it, for tools, clock, randomness and captured HTTP
alike.

- Scopes nest by joining with `/`: `researcher` inside `team` is `team/researcher`.
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
where occurrence is *n* for the *n*-th identical call in that scope. This is why `args` must be
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
4. Handle all six response shapes; treat an unknown `origin` as an error.
5. `complete` every `live` and `stubbed` call, on both the success and the failure path.
6. One round trip for clock and randomness, with no `complete`.
7. Scope propagation through the language's implicit context, as `x-shadowlap-scope`.
8. A replayed-error type and a write-blocked type.
9. Fail closed: never run the implementation because the sidecar was unreachable.
10. Run the [conformance suite](https://github.com/devjoinedthechat/shadowlap/tree/main/testing/conformance).

## Versioning

This protocol is pre-1.0 and may change. The sidecar reports its version in `shadowlap --version`;
there is no protocol version negotiation yet. When one is added it will be an additive header, and
a client that does not send it will keep working.
