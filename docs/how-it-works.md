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

`shadowlap run` starts a loopback HTTP server, points the provider SDKs at it through their base-URL environment variables, and spawns your agent. Clients that can't be pointed anywhere (Bedrock signs each request for its host; Azure and Vertex take their endpoint in code) are captured inside Node and Python processes instead: the request goes to the sidecar unchanged, naming the host it was for, and the sidecar forwards it only to a host that provider owns. See [Providers](./providers.md#in-process-capture). Model API calls pass through the proxy; streamed responses are forwarded byte-for-byte as they arrive and stored with per-event timing. A compressed answer is decoded first, while the agent's own `accept-encoding` goes upstream as it was sent, since a signed request (AWS SigV4, as Python's `AnthropicBedrock` makes one) can sign it. Tool, clock and random calls come from the SDK over a small resolution API. A model call's API key and authorization headers are forwarded upstream and never stored, nor are a [captured HTTP call](./sdk.md#http-services-without-wrapping)'s request headers and the credentials in its query string or form body; a key the agent puts anywhere else is stored like any other value, for a [redaction rule](./normalizers-and-redaction.md#redaction) to mask. The server requires a per-session token in every URL, so other local processes can't read recordings through it. Behind a proxy (`HTTP_PROXY`, `HTTPS_PROXY`), the agent still reaches the sidecar directly: `shadowlap run` adds `127.0.0.1`, `localhost` and `::1` to `NO_PROXY` and `no_proxy`, keeping what they held, and the SDKs, the preloads and in-process capture never send a call for the sidecar through a proxy, so no proxy sees a key, a prompt or the session token. That holds for a proxy an agent sets up in code too (an `http.globalAgent` a proxy package replaced, a Python opener), with one exception: a Node agent's own `fetch` goes where its dispatcher sends it, and undici's `ProxyAgent` set with `setGlobalDispatcher` ignores `NO_PROXY`, so its model calls go to its proxy and fail. Use undici's `EnvHttpProxyAgent`, which honours the `NO_PROXY` Shadowlap sets.

Two things under a provider's path aren't model calls. A WebSocket, such as OpenAI's Realtime API, is tunnelled to the hosts that provider's calls may go to, and nothing sent over it is recorded: the run's summary names it, a replay connects again for real, and an offline replay (`shadowlap test`) refuses it in one line. An SDK's own telemetry, the OpenAI Agents SDK's trace export to `/v1/traces/ingest`, is passed on while recording and never recorded or matched; a replay answers it with `204` itself, so a replay's traces don't reach the provider.

One engine, many languages: fingerprinting, matching and storage exist once in the sidecar. The SDKs are thin HTTP clients.

## Calls and identity

Every intercepted operation is a **call**: `api` (a model request), `tool`, `clock` or `random`. A call's identity for matching is its **call key**:

```
(kind, fingerprint, occurrence)
```

- The **fingerprint** is a SHA-256 of the canonical request: method and path (a Vertex AI path without its `/projects/<project>/locations/<region>`, which come from each developer's or CI's environment, so a recording replays in another project; the call keeps its full path as its name), the few headers that change model behavior (`anthropic-version`, `anthropic-beta`, `openai-beta`; a divergence report shows a change to one as `headers.<name>`, and a recording that names no API version, such as one [imported from a trace](./cli.md#traces), matches whatever version the agent's SDK names), and the body serialized with the JSON Canonicalization Scheme (RFC 8785), after your [normalizers](./normalizers-and-redaction.md). Key order, whitespace and string escaping don't matter; any semantic change does. Exactly one built-in exclusion exists: `cache_control` markers, which the provider documents as behavior-neutral. A multipart upload (an audio transcription, a file upload, an image edit) is read as its parts, not its bytes: each part's name, filename and content type, a field's text, and a file's SHA-256, so the random boundary its client picks for every request doesn't count, and a divergence report shows a changed part as `$.multipart[n]`. The upload is stored and sent upstream as it was.
- The **occurrence** is *n* for the *n*-th call in the run with the same kind and fingerprint, counted within the call's [scope](./sdk.md#scopes) when the recording has scopes. The third identical `read_file("config.json")` matches the third recorded one.

Arrival order is never part of the identity. Parallel tool calls (`Promise.all`, `asyncio.gather`) interleave differently on replay, because replayed responses return instantly, and they still match. The one known limit: identical requests issued *concurrently* (say, two sub-agents that start with the same prompt) may receive each other's recorded responses; the set is right, the assignment is not guaranteed. Run each branch in a [scope](./sdk.md#scopes) and each keeps its own answers. Within one scope the limit remains, which only matters when the identical requests' answers are used differently.

Around a fork, arrival order does matter, and only there. Calls that reach Shadowlap before the first changed call are still served from the recording; calls after it follow the fork policy. So when a turn issues a changed `read` and an unchanged `write` concurrently, the write is either replayed (its recorded result, nothing re-sent) or blocked, depending on which request arrives first. A side effect is never repeated in either case. When the order has to be deterministic, issue the write after the call it depends on, which is what an agent that emails *about* search results does anyway.

## The replay state machine

A replay is `REPLAYING` until the first call whose key has no unconsumed recorded counterpart, then `DIVERGED`, with one exception: a plain read (a clock read, a random value, a `pure` tool's call) that has none is answered live and the replay stays `REPLAYING`.

```
resolve(kind, request):
  fp  = fingerprint(kind, normalize(request))
  occ = next_occurrence(kind, fp)
  if REPLAYING and not forced_live:
    rec = parent.find(kind, fp, occ)
    if rec exists and is complete:      serve rec.response      (origin: replayed)
    elif kind is clock, random or pure: execute live; stay REPLAYING  (an extra read)
    else:                               DIVERGED; explain
  # live region
  if kind == tool and effect == write:  block | stub | allow    (--writes)
  execute live; store                                           (origin: live)
```

**Extra reads.** A plain read changes nothing outside the agent, so one the recording never held (an agent changed to log a timestamp, to tag a request with a fresh id) is no change to what the agent did. It runs live, and every call after it is still matched against the recording. What the agent does with the value shows in the next request that carries it, which is matched as strictly as ever, so a timestamp that reaches a prompt still forks there. The run marks each one (`extraRead` on the call), its summary lists them (`2 extra reads answered live, with no recorded counterpart: #3 clock now, #4 random uuid`), `shadowlap test` counts them on the golden's line, and a later divergence names those before it, since one of their values may be what changed its request. Leftover reads are the other side of the same rule: a replay that never makes a recorded clock, random or pure read hasn't ended early. An extra `read` tool call still forks, since what it returns may have changed in the world, and so does an extra `write`. A plain read a flag forces live (`--diverge-at`, `--live-tool`) forks as before.

**Prefix semantics.** Once diverged, every later model call and `read` tool runs live, so live results never mix with stale reads of a world that may have changed. `pure` tools are the exception: a pure result is a function of its arguments by declaration, so matching pure calls are still served from the recording. `--reads replay` extends that to `read` tools for offline forks, with the staleness caveat.

**Retries.** The official SDKs retry 408/409/429/5xx themselves and mark each attempt with `x-stainless-retry-count`. Attempts are stored under one call; replay serves the final outcome, so replays never repeat backoff waits. Non-retryable errors (a 400) are stored as the outcome and replayed as-is, so the SDK raises the same typed exception it raised during recording. Identical requests in flight at once (best-of-n sampling) keep a call each: a retry goes to the oldest identical call whose last attempt failed and that has nothing in flight.

**Failures on the way.** An agent that leaves before its answer is whole (its SDK timed out, or it stopped reading a stream) ends the request upstream with it, so nothing runs on unseen. That attempt is stored as a retryable disconnect, so the SDK's retry is the same call and a replay serves the answer the agent got. A call to a [declared HTTP host](./sdk.md#http-services-without-wrapping) that the agent gave up on is recorded the same way, and its replay closes the agent's connection again without an answer, since it got none then. A stream the provider cuts part way reaches the agent as it arrived and then breaks, as it would without Shadowlap; a replay breaks it at the same place.

**Forcing divergence.** Changing a tool's implementation doesn't change its call key, so a fixed tool would keep replaying its old result. `--live-tool <name>` forces its first call live, and every call of it after a fork; `--diverge-at <n>` forces call *n*. The SDKs record a hash of each tool's source, and the report warns when it changed since the recording.

## Effects

Tools declare what they do to the world outside their arguments:

| Effect | Recording | Replay, before divergence | Replay, after divergence |
|---|---|---|---|
| `pure` | execute, store | serve recorded; one with no recorded counterpart runs live and the replay goes on | serve recorded when identical, otherwise execute |
| `read` | execute, store | serve recorded | execute live (`--reads replay` serves recorded matches) |
| `write` | execute, store | serve recorded (never executed) | `block` (default, throws `ShadowlapWriteBlocked` into the agent), `stub` (returns `onFork(args)`), or `allow` |

`effect` is required. The only safe default would be `write`, and making that implicit would hide a decision the developer must make.

## Tools Shadowlap did not record

A recording keeps every model answer, and each answer names the tools the model asked for: Anthropic's `tool_use`, OpenAI's `tool_calls`, the Responses API's `function_call`, Gemini's `functionCall`. A tool the agent wraps leaves a call of its own in the run. One it doesn't wrap (a framework's tool, a built-in such as the Claude Agent SDK's `Bash`, an MCP server reached without [`shadowlap mcp`](./mcp.md)) ran in the agent unseen, and a replay, which serves the answer that asked for it, runs it again for real. Shadowlap reads the run for these, so it finds tools a scan of the code misses:

```
! The model called 2 tools Shadowlap did not record: they ran in your agent unseen, and a replay runs them for real
    lookup_kb  3 calls from model call #2 · "lookup" only looks
    Bash       14 calls from model call #3 · a built-in that writes
  Bash writes, so shadowlap replay and test refuse to run it again until it is recorded, declared a read, or allowed with --allow-unrecorded.
```

`run` and `replay` name them at the end, `show` above the timeline, and `show --json` and `--summary-json` list them as `unrecordedTools`: each tool's `name`, how often the model asked for it (`count`), the model call that first did (`firstCallNo`), its `effect` (`write`, `read` or `unknown`) and `why`. An MCP tool the model calls by its server's prefix (`mcp__kb__search_kb`) counts as recorded when `shadowlap mcp` recorded it under its own name. A tool the provider runs itself (web search, code execution, its MCP connector) answers inside the response and runs nowhere in the agent, so it is never listed.

A tool's effect is, in order: what `tools.unrecorded` in `shadowlap.config.json` declares; a built-in's (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, computer use, Anthropic's bash and text editor and the Responses API's shell and `apply_patch` write; `Read`, `Glob`, `Grep`, `WebFetch` and `WebSearch` only read); the verb its name leads with, as [`shadowlap init`](./cli.md#init) suggests effects (`send_email` writes, `lookup_order` reads); else unknown.

`replay` and `test` refuse a recording whose unrecorded tools include a write, before anything runs, naming each (exit status 2). Wrap the tool where the agent runs it, so it is recorded and replayed. If running it again is safe, declare it a read:

```json
{ "tools": { "unrecorded": { "Bash": "write", "lookup_kb": "read" } } }
```

Or let one replay run it anyway: `--allow-unrecorded Bash` (names separated by commas, repeatable). A read, and a tool of unknown effect, are only named. A partial recording, such as an [import](./cli.md#import), holds a trace's model calls and the tools it kept, and runs every other tool live by design, so it is never refused.

## The network guard

Only calls that go through Shadowlap can be replayed; a tool that isn't wrapped (a direct database client, a raw `fetch`) would execute during a replay with nothing to say so. The guard closes that hole without code changes: `shadowlap run`, `replay` and `test` preload a small module into the agent process (Node through `NODE_OPTIONS --import`, which needs Node 18.18 or later; Python through a `sitecustomize` on `PYTHONPATH`; other runtimes ignore both) that intercepts every outbound socket connection. The sidecar is allowed. Anything else is a side effect Shadowlap cannot replay:

- `--guard warn` (default for `run` and `replay`): the connection proceeds, a one-line warning names the host on stderr, and the run summary lists every bypassing target with a count.
- `--guard block` (default for `shadowlap test`): the connection is refused before any bytes leave, with an error the agent can catch (`ESHADOWLAP` in Node, `OSError` in Python).
- `--guard off`: nothing is intercepted.

`SHADOWLAP_GUARD_ALLOW=host:port,host:port` whitelists targets you accept (a local database in development, for example). Unix sockets and pipes are local IPC and always allowed. The guard also runs during recording, so a recording's summary already tells you which hosts your agent talks to outside Shadowlap, before you ever replay. The run keeps the list too, for its page in the [dashboard](./dashboard.md#what-a-runs-page-is-worked-out-from).

Node names a target by the host the agent asked for. Python connects to the address a name resolved to, so its guard names a target by the names that resolved to that address (`api.stripe.com:443`, not the address); when several did, as behind a CDN or a shared load balancer, the address is shown with all of them (`104.18.7.1:443 (api.example.com, cdn.example.com)`). Since those hosts can't be told apart when the connection opens, an allowed host name lets a Python connection through only while every name that resolved to its address is allowed. Allow the address itself (`104.18.7.1:443`) to let them all through.

## Keys

A live call carries your key: the sidecar forwards it upstream and never stores it. What a recording answers needs no key, but a model client built the default way (`new Anthropic()`, `new OpenAI()`, Google's `GoogleGenAI` or `genai.Client()`) reads its key from the environment and refuses to send anything without one. So a replay gives the agent a placeholder for each provider its recording called when the environment has no credential for it, and the client sends what the recording answers:

| Provider | Placeholder |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY=shadowlap-offline-replay-placeholder` |
| OpenAI | `OPENAI_API_KEY=shadowlap-offline-replay-placeholder` |
| Gemini | The same value in `GEMINI_API_KEY` and `GOOGLE_API_KEY`, or in the one of them the recording's environment held |
| Azure OpenAI | `AZURE_OPENAI_API_KEY=shadowlap-offline-replay-placeholder`, only when the recording's environment held `AZURE_OPENAI_API_KEY` |
| Bedrock | `AWS_ACCESS_KEY_ID=SHADOWLAPREPLAY` and `AWS_SECRET_ACCESS_KEY=shadowlap-offline-replay-placeholder` |

A placeholder never replaces a credential you set, of any kind the provider's SDKs read: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID` or the active Anthropic profile (in `ANTHROPIC_CONFIG_DIR`, `$XDG_CONFIG_HOME/anthropic` or `~/.config/anthropic`); `OPENAI_ADMIN_KEY`; Microsoft Entra ID (`AZURE_OPENAI_AD_TOKEN`, `AZURE_CLIENT_ID`, `AZURE_FEDERATED_TOKEN_FILE`, a managed identity's `IDENTITY_ENDPOINT` or `MSI_ENDPOINT`) or an Azure CLI sign-in; `AWS_PROFILE`, AWS's shared credentials and config files, web identity, container credentials or a Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`). An empty variable, which is what a pull request from a fork gets for a secret, counts as none. Azure OpenAI gets one only for a recording whose environment held the key itself: the Node client refuses a key beside a token provider, which no variable shows. Vertex AI clients fetch a token before they call it, which no placeholder stands in for ([Providers](./providers.md#credentials-on-replay)). With `SHADOWLAP_CAPTURE=off`, Azure OpenAI and Bedrock get none, since their calls would then go straight to the provider.

A placeholder is never sent, to any host: a provider, a gateway, a model server on this machine or a mock. The sidecar answers a live call that carries one, in any header, in an AWS signature or in the query string, with one line instead of sending it:

```
a live call needs a real key: set ANTHROPIC_API_KEY, or keep the replay offline
```

The agent gets it as the provider's own 401 (`UnrecognizedClientException` from Bedrock), and the replay's summary prints it under the fork line, which counts the call as refused, not as an upstream request. A call to a host declared under `http` that passes one on, such as a vector store that embeds with the caller's OpenAI key, is answered the same way, the line naming the call.

Which commands are offline, and which may go live:

- **Offline:** a clean replay; `shadowlap test` and the [GitHub Action](./ci.md#github-actions), but for `--online`, a golden marked `fork` and a gate with `fork: true`; [recorded tests](./testing.md) under pytest, Vitest and node:test; `bisect` without `--fork`; `calibrate`; `coverage --pack`; the replay `decisions --from-code` reads the working tree's prompt with; and `check`, and the checks `verify` reads from a recording, which run nothing. None of them needs a key. Each replay gets a placeholder for every provider its recording called whose credential the environment lacks (Azure OpenAI's as above), and a call the recording doesn't hold fails as offline, never live. A recorded test's process holds them only while the test runs, each where its variable is empty, and has the variable back as it was afterwards.
- **May go live:** a fork, whether the code changed a request or a flag did (`--inject`, `--set`, `--model`, `--override`, `--fail-at`, `--inject-result`, `--prompt-from`, `--diverge-at`), `--live-tool` and `--live-input`; `test --online` and `--update`, a golden marked `fork` and a gate with `fork: true`; `--chaos`; the attempts of `blame`, `verify` and `repair`; `injection`, `bisect --fork`, `decisions`, `migrate` and `tasks score`; a judge asked live. A live call needs a real key, and none of these gives a placeholder but `shadowlap replay`.
- **`shadowlap replay`**, with `--repeat` and `--watch` too, is offline until it forks. It gives its agent a placeholder only for a provider whose key the recording's own environment held, which a run keeps by name, never by value (`keyEnv` in its [metadata](./recording-format.md#a-run)): the agent took its key from the environment then, so a clean replay needs none now, and a fork stops at its first live call with the line above. An agent that brings its key itself (from a `.env` file it loads, or a local server's `ollama`) or signs in another way (a token provider, an instance role) gets none, so its fork goes live with what it has. A recording that doesn't say, such as an import, gets none.

## Where forks happen

A replay forks at the first **request** that changes, not where the bug is. That splits changes into three classes:

1. **Changes that alter no request.** Response parsing, tool dispatch, state management, stop conditions, error handling, logging: the harness around the model. These replay end to end at zero cost against the model's exact recorded behavior. A large share of agent bugs live here.
2. **Changes that alter late requests.** A sub-agent prompt first used at call 20, a tool whose fixed result changes call 9, a different tool result injected at call *k*. The unchanged prefix replays; the suffix runs live with writes fenced.
3. **Changes that alter every request.** The top-level system prompt and tool definitions are sent with every model call, so editing them diverges at call 1. Shadowlap still provides the diff, a fork whose writes are fenced, and the lineage, but no token savings. No design can serve a recorded response to a request the model never saw.

Class 3 is why [interventions](./interventions.md) exist, and why the [decision diff](./decisions.md) does: it asks each recorded model call again with only the changed prompt or model, so the change's effect on every step shows before a live run of anything.

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

`shadowlap import` sets this. The mechanism is general: any source that sees some kinds
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
- **Writes never hold an answer up.** When another process holds the store (the dashboard, `gc`, another recording), a call's rows wait their turn, in order, and are written once it is free. One that still can't be written after 10 seconds is kept as an error end where it can be, and the run's summary says so.
- **Fingerprints** a replay matches by are cached with the dates each request holds, keyed by the request and every rule that went into them (the fingerprint version, normalizers and redaction rules, the clock setting). The recording fills the cache, so a replay of a 1,000-call run starts in well under a second however large its requests. A replay whose start masks a request's dates differently works that fingerprint out again, and `gc` drops the entries of requests it deletes.
- **Blobs** are content-addressed by SHA-256. Every model request resends the whole conversation, so whole-request blobs would never deduplicate; a request is stored as a manifest that references `system`, `tools` and each message separately. A 30-call run stores 77 unique chunks, not 11 full copies.
- Responses are stored raw (JSON or SSE bytes) with status, filtered headers and per-event timing, which is what makes the TUI's play mode possible.

Every run is self-contained: a replay stores a row for every call, including replayed ones, pointing at the same blobs. Reading a fork never requires stitching a parent onto it, and deleting a parent doesn't break its children. [`shadowlap pack`](./cli.md#pack-unpack) exports a run as a git-friendly directory.
