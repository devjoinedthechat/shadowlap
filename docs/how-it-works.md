# How it works

## The sidecar

```
shadowlap run -- python agent.py
│
├── sidecar  (127.0.0.1, random port, per-session token)
│   ├── /anthropic/*  /openai/*  /gemini/*   record/replay proxy ──►  the provider (live calls only)
│   ├── /azure/*  /vertex/*  /bedrock/*      (HTTP/1.1, and cleartext HTTP/2 for the AWS SDK)
│   ├── /v1/calls/*                          tool, clock and random resolution  ◄── the SDK
│   └── store                                .shadowlap/shadowlap.db  (SQLite)
│
└── your agent    env: ANTHROPIC_BASE_URL, OPENAI_BASE_URL, GOOGLE_GEMINI_BASE_URL, SHADOWLAP_URL, SHADOWLAP_RUN_ID
                  preload: in-process capture and the network guard (Node and Python)
```

`shadowlap run` starts a loopback HTTP server, points the provider SDKs at it through their base-URL environment variables, and spawns your agent. Clients that can't be pointed anywhere (Bedrock signs each request for its host; Azure and Vertex take their endpoint in code) are captured inside Node and Python processes instead: the request goes to the sidecar unchanged, naming the host it was for, and the sidecar forwards it only to a host that provider owns. See [Providers](./providers.md#in-process-capture). Model API calls pass through the proxy; streamed responses are forwarded byte-for-byte as they arrive and stored with per-event timing. Tool, clock and random calls come from the SDK over a small resolution API. Credentials are forwarded upstream and never stored; the server requires a per-session token in every URL, so other local processes can't read recordings through it.

One engine, many languages: fingerprinting, matching and storage exist once in the sidecar. The SDKs are thin HTTP clients.

## Calls and identity

Every intercepted operation is a **call**: `api` (a model request), `tool`, `clock` or `random`. A call's identity for matching is its **call key**:

```
(kind, fingerprint, occurrence)
```

- The **fingerprint** is a SHA-256 of the canonical request: method and path (a Vertex AI path without its `/projects/<project>/locations/<region>`, which come from each developer's or CI's environment, so a recording replays in another project; the call keeps its full path as its name), the few headers that change model behavior (`anthropic-version`, `anthropic-beta`, `openai-beta`; a divergence report shows a change to one as `headers.<name>`), and the body serialized with the JSON Canonicalization Scheme (RFC 8785), after your [normalizers](./normalizers-and-redaction.md). Key order, whitespace and string escaping don't matter; any semantic change does. Exactly one built-in exclusion exists: `cache_control` markers, which the provider documents as behavior-neutral. A multipart upload (an audio transcription, a file upload, an image edit) is read as its parts, not its bytes: each part's name, filename and content type, a field's text, and a file's SHA-256, so the random boundary its client picks for every request doesn't count, and a divergence report shows a changed part as `$.multipart[n]`. The upload is stored and sent upstream as it was.
- The **occurrence** is *n* for the *n*-th call in the run with the same kind and fingerprint, counted within the call's [scope](./sdk.md#scopes) when the recording has scopes. The third identical `read_file("config.json")` matches the third recorded one.

Arrival order is never part of the identity. Parallel tool calls (`Promise.all`, `asyncio.gather`) interleave differently on replay, because replayed responses return instantly, and they still match. The one known limit: identical requests issued *concurrently* (say, two sub-agents that start with the same prompt) may receive each other's recorded responses; the set is right, the assignment is not guaranteed. Run each branch in a [scope](./sdk.md#scopes) and each keeps its own answers. Within one scope the limit remains, which only matters when the identical requests' answers are used differently.

Around a fork, arrival order does matter, and only there. Calls that reach Shadowlap before the first changed call are still served from the recording; calls after it follow the fork policy. So when a turn issues a changed `read` and an unchanged `write` concurrently, the write is either replayed (its recorded result, nothing re-sent) or blocked, depending on which request arrives first. A side effect is never repeated in either case. When the order has to be deterministic, issue the write after the call it depends on, which is what an agent that emails *about* search results does anyway.

## The replay state machine

A replay is `REPLAYING` until the first call whose key has no unconsumed recorded counterpart, then `DIVERGED`.

```
resolve(kind, request):
  fp  = fingerprint(kind, normalize(request))
  occ = next_occurrence(kind, fp)
  if REPLAYING and not forced_live:
    rec = parent.find(kind, fp, occ)
    if rec exists and is complete:      serve rec.response      (origin: replayed)
    else:                               DIVERGED; explain
  # live region
  if kind == tool and effect == write:  block | stub | allow    (--writes)
  execute live; store                                           (origin: live)
```

**Prefix semantics.** Once diverged, every later model call and `read` tool runs live, so live results never mix with stale reads of a world that may have changed. `pure` tools are the exception: a pure result is a function of its arguments by declaration, so matching pure calls are still served from the recording. `--reads replay` extends that to `read` tools for offline forks, with the staleness caveat.

**Retries.** The official SDKs retry 408/409/429/5xx themselves and mark each attempt with `x-stainless-retry-count`. Attempts are stored under one call; replay serves the final outcome, so replays never repeat backoff waits. Non-retryable errors (a 400) are stored as the outcome and replayed as-is, so the SDK raises the same typed exception it raised during recording.

**Forcing divergence.** Changing a tool's implementation doesn't change its call key, so a fixed tool would keep replaying its old result. `--live-tool <name>` forces its first call live, and every call of it after a fork; `--diverge-at <n>` forces call *n*. The SDKs record a hash of each tool's source, and the report warns when it changed since the recording.

## Effects

Tools declare what they do to the world outside their arguments:

| Effect | Recording | Replay, before divergence | Replay, after divergence |
|---|---|---|---|
| `pure` | execute, store | serve recorded | serve recorded when identical, otherwise execute |
| `read` | execute, store | serve recorded | execute live (`--reads replay` serves recorded matches) |
| `write` | execute, store | serve recorded (never executed) | `block` (default, throws `ShadowlapWriteBlocked` into the agent), `stub` (returns `onFork(args)`), or `allow` |

`effect` is required. The only safe default would be `write`, and making that implicit would hide a decision the developer must make.

## The network guard

Only calls that go through Shadowlap can be replayed; a tool that isn't wrapped (a direct database client, a raw `fetch`) would execute during a replay with nothing to say so. The guard closes that hole without code changes: `shadowlap run`, `replay` and `test` preload a small module into the agent process (Node through `NODE_OPTIONS --import`, Python through a `sitecustomize` on `PYTHONPATH`; other runtimes ignore both) that intercepts every outbound socket connection. The sidecar is allowed. Anything else is a side effect Shadowlap cannot replay:

- `--guard warn` (default for `run` and `replay`): the connection proceeds, a one-line warning names the host on stderr, and the run summary lists every bypassing target with a count.
- `--guard block` (default for `shadowlap test`): the connection is refused before any bytes leave, with an error the agent can catch (`ESHADOWLAP` in Node, `OSError` in Python).
- `--guard off`: nothing is intercepted.

`SHADOWLAP_GUARD_ALLOW=host:port,host:port` whitelists targets you accept (a local database in development, for example). Unix sockets and pipes are local IPC and always allowed. The guard also runs during recording, so a recording's summary already tells you which hosts your agent talks to outside Shadowlap, before you ever replay. The run keeps the list too, for its page in the [dashboard](./dashboard.md#what-a-runs-page-is-worked-out-from).

Node names a target by the host the agent asked for. Python connects to the address a name resolved to, so its guard names a target by the names that resolved to that address (`api.stripe.com:443`, not the address); when several did, as behind a CDN or a shared load balancer, the address is shown with all of them (`104.18.7.1:443 (api.example.com, cdn.example.com)`). Since those hosts can't be told apart when the connection opens, an allowed host name lets a Python connection through only while every name that resolved to its address is allowed. Allow the address itself (`104.18.7.1:443`) to let them all through.

## Where forks happen

A replay forks at the first **request** that changes, not where the bug is. That splits changes into three classes:

1. **Changes that alter no request.** Response parsing, tool dispatch, state management, stop conditions, error handling, logging: the harness around the model. These replay end to end at zero cost against the model's exact recorded behavior. A large share of agent bugs live here.
2. **Changes that alter late requests.** A sub-agent prompt first used at call 20, a tool whose fixed result changes call 9, a different tool result injected at call *k*. The unchanged prefix replays; the suffix runs live with writes fenced.
3. **Changes that alter every request.** The top-level system prompt and tool definitions are sent with every model call, so editing them diverges at call 1. Shadowlap still provides the diff, a fork whose writes are fenced, and the lineage, but no token savings. No design can serve a recorded response to a request the model never saw.

Class 3 is why [interventions](./interventions.md) exist.

## Partial recordings

A recording made by `shadowlap run` contains every call the agent made: model calls, tool calls,
clock reads and random values. A recording built from traffic something else captured contains only
what crossed the network. It is a **partial recording**, and it says so: `meta.covers` lists the
call kinds it holds.

This matters because of how divergence works. A replay diverges when a call has no match in the
recording — which is exactly right when the recording should have had one, and exactly wrong when
it never could. Most agents read the clock or call a tool before their first model call, so without
this distinction a capture of the network would fork at call 1, every time.

So a replay of a partial recording:

- serves the kinds it covers from the recording, matched as strictly as ever;
- runs every other kind **live**, without ending the replay;
- still fences write tools according to `--writes`, because a live write is a real side effect whether or not the recording expected it.

Two consequences worth knowing:

- **Values the agent generates leak back in.** With the clock and randomness running live, a request id or timestamp the agent puts into a prompt differs from the capture and forks the replay. The report names it and suggests the [normalizer](./normalizers-and-redaction.md); that is the usual first step after an import.
- **Replaying a partial recording produces a complete one.** The model calls come from the capture and everything else is recorded live, so the resulting run covers everything — which is what you pack as a CI golden. An imported HAR is the start of a recording, not the end of one.

`shadowlap import` is what sets this today. The mechanism is general: any source that sees some kinds
and not others describes itself the same way. A [trace](./cli.md#traces) can hold some tools' calls
and not others': it lists each tool whose every call it kept as `tool:<name>` (`["api",
"tool:lookup_order"]`), and those calls replay while every other tool runs live.

## Thinking blocks

Current Claude models bind each thinking block to the model that produced it and to the conversation prefix that produced it: the top-level `system`, the `tools` set and every earlier message. Editing any of those in a later request invalidates every later block; on organizations created on or after 2026-08-31 the request is rejected unless it opts into dropping the blocks.

Forks are compatible by construction: the history before divergence is exactly what was recorded, and nothing edits it. Interventions are designed around the same rule: an override changes only content after the last recorded block, an injection is appended and then kept at the same position, and parameter patches touch fields that aren't bound. "Rewind to step 15 and change the prompt" is therefore an *addition* at step 15, not a change to what steps 1–14 saw.

## Storage

Local-first: `.shadowlap/shadowlap.db`, one SQLite file in WAL mode, created with a `.gitignore` so recordings stay out of version control.

- **Runs** carry mode (record or replay), status, lineage (`parent_run_id`), the divergence report, the command, and the git revision.
- **Call events** are append-only: a `start` row when a call is resolved and an `end` row when it completes, so a crash leaves a visible pending call rather than a half-written record. Retries are extra end rows.
- **Blobs** are content-addressed by SHA-256. Every model request resends the whole conversation, so whole-request blobs would never deduplicate; a request is stored as a manifest that references `system`, `tools` and each message separately. A 30-call run stores 77 unique chunks, not 11 full copies.
- Responses are stored raw (JSON or SSE bytes) with status, filtered headers and per-event timing, which is what makes the TUI's play mode possible.

Every run is self-contained: a replay stores a row for every call, including replayed ones, pointing at the same blobs. Reading a fork never requires stitching a parent onto it, and deleting a parent doesn't break its children. [`shadowlap pack`](./cli.md#pack-unpack) exports a run as a git-friendly directory.
