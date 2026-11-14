# How it works

This page explains the mechanism under every shadowlap command: how a run is recorded, how a replay
matches each call to the recording, and where a fork goes live. Read it when a replay does something
you didn't expect, or before you build on shadowlap.

## The loop

1. **Record.** `shadowlap run` starts the [sidecar](#the-sidecar), points the agent's model clients at
   it, and runs the agent. Every model call, tool call, clock read and random value is stored as a
   [call](#calls-and-identity) of the run.
2. **Replay.** `shadowlap replay` runs the agent's real code again. Each call is matched by its
   [identity](#calls-and-identity) and served from the recording: no tokens spent, no side effects
   repeated.
3. **Fork.** The first request with no recorded match is reported with a diff, and the run goes on
   live from there, with [write tools fenced](#effects). See [where forks happen](#where-forks-happen).
4. **Keep.** Every run is a row in the [store](#storage), and a
   [pack](./recording-format.md#a-pack) exports one as files you can commit as a golden.

## Terms

The words the rest of the docs use for the parts of that loop:

| Term | Meaning |
|---|---|
| **Run** | One execution of the agent under shadowlap, a recording or a replay. The [store](#storage) keeps every run |
| **Recording** | A run `shadowlap run` made: every call the agent made, and what it heard back |
| **Call** | One intercepted operation: a model request (`api`), a `tool` call, a `clock` read or a `random` value |
| **Replay** | A run of the agent's real code against a recording, every unchanged call served from it |
| **Divergence** | The first call a replay can't serve from its recording ([the replay state machine](#the-replay-state-machine)) |
| **Fork** | A replay that diverged: from the first changed request on it runs live, with writes fenced |
| **Effect** | What a tool declares it does to the world: `pure`, `read` or `write` ([effects](#effects)) |
| **Fence** | What a fork does to a write tool: blocks it (the default), stubs it or allows it |
| **Golden** | A run kept as a pack in the repository and replayed offline on every pull request ([CI](./ci.md)) |
| **Pack** | A run exported as a folder of plain files ([the recording format](./recording-format.md#a-pack)) |
| **Sidecar** | The local server that records and replays the agent's calls ([the sidecar](#the-sidecar)) |
| **Guard** | The preload that watches the agent's outbound connections ([the network guard](#the-network-guard)) |
| **Store** | `.shadowlap/shadowlap.db`, the SQLite file every run is kept in ([storage](#storage)) |

The Claude Agent SDK's fence (`withFence`) records and fences Claude Code's built-in tools, which no
wrapper reaches ([Claude Agent SDK](./frameworks.md#claude-agent-sdk)).

## The sidecar

```text
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

`shadowlap run`:

1. starts a loopback HTTP server;
2. points the provider SDKs at it through their base-URL environment variables;
3. spawns your agent.

Clients that can't be pointed anywhere are captured inside Node and Python processes instead: Bedrock
signs each request for its host, and Azure and Vertex take their endpoint in code. The request goes to
the sidecar unchanged, naming the host it was for, and the sidecar forwards it only to a host that
provider owns. See [Providers](./providers.md#in-process-capture).

One engine, many languages: fingerprinting, matching and storage exist once in the sidecar. The SDKs
are thin HTTP clients.

### What passes through it

- **Model API calls** pass through the proxy. Streamed responses are forwarded byte-for-byte as they
  arrive and stored with per-event timing.
- **A compressed answer** is decoded first, while the agent's own `accept-encoding` goes upstream as
  it was sent, since a signed request (AWS SigV4, as Python's `AnthropicBedrock` makes one) can sign
  it.
- **Tool, clock and random calls** come from the SDK over a small resolution API.
- **A model API's answer** is passed on and recorded without a `location` header: no model API
  redirects, and a client that follows one sends its key along.

### What it never stores

- **A model call's API key and authorization headers** are forwarded upstream and never stored.
- **A [captured HTTP call](./sdk.md#http-services-without-wrapping)'s request headers**, and the
  credentials in its query string or form body, are never stored either.

A key the agent puts anywhere else is stored like any other value, for a
[redaction rule](./normalizers-and-redaction.md#redaction) to mask.

### Who can reach it

- **The server requires a per-session token in every URL**, so other local processes can't read
  recordings through it.
- **It answers only requests that name it by a loopback address**, or that in-process capture
  redirected to it, naming the host they were for. So a page in a browser on another name that
  resolves to `127.0.0.1` gets nothing.

### Behind a proxy

Behind a proxy (`HTTP_PROXY`, `HTTPS_PROXY`), the agent still reaches the sidecar directly, so no
proxy sees a key, a prompt or the session token:

- `shadowlap run` adds `127.0.0.1`, `localhost` and `::1` to `NO_PROXY` and `no_proxy`, keeping what
  they held.
- The SDKs, the preloads and in-process capture never send a call for the sidecar through a proxy.

That holds for a proxy an agent sets up in code too, since in-process capture sends each call for the
sidecar on a connection of its own:

- an `http.globalAgent` a proxy package replaced;
- a Python opener;
- a Node agent's own `fetch`, whatever its dispatcher, undici's `ProxyAgent` set with
  `setGlobalDispatcher` included, which ignores `NO_PROXY`.

One thing still follows that dispatcher: a WebSocket opened with Node's own `WebSocket`, a Realtime
connection. Use undici's `EnvHttpProxyAgent` there, which honours the `NO_PROXY` shadowlap sets.

### WebSockets and telemetry

Two things under a provider's path aren't model calls:

- **A WebSocket**, such as OpenAI's Realtime API, is tunnelled to the hosts that provider's calls may
  go to, and nothing sent over it is recorded. The run's summary names it, a replay connects again
  for real, and an offline replay (`shadowlap test`) refuses it in one line.
- **An SDK's own telemetry**, the OpenAI Agents SDK's trace export to `/v1/traces/ingest`, is passed
  on while recording and never recorded or matched. A replay answers it with `204` itself, so a
  replay's traces don't reach the provider.

While recording, telemetry goes to the host the agent sent it to, as in-process capture names it.
That holds even when `SHADOWLAP_UPSTREAM_OPENAI` sends the model calls to a local server or a mock,
which holds no traces. Telemetry sent through the base URL goes where the model calls go.

## Calls and identity

Every intercepted operation is a **call**: `api` (a model request), `tool`, `clock` or `random`. A
call's identity for matching is its **call key**:

```text
(kind, fingerprint, occurrence)
```

### The fingerprint

The **fingerprint** is a SHA-256 of the canonical request. Key order, whitespace and string escaping
don't matter; any semantic change does. For a model request it covers:

| Part | What counts |
|---|---|
| Method and path | The request's method and its path, as below |
| Headers | The few headers that change model behavior: `anthropic-version`, `anthropic-beta`, `openai-beta` |
| Query | The query string's parameters, sorted, never a credential |
| Body | The body serialized with the JSON Canonicalization Scheme (RFC 8785), after your [normalizers](./normalizers-and-redaction.md) |

A tool call's fingerprint is its name and arguments, after your normalizers. A clock or random read's
is its kind, its name (`now`, `random`, `uuid`) and its label. So an agent changed to ask for a random
number before its uuid gets a number, live, and its uuid from the recording.

**Method and path.** A Vertex AI path is read without its `/projects/<project>/locations/<region>`,
which come from each developer's or CI's environment, so a recording replays in another project. A
path under the root of a host that serves another provider's format is read as that format's own API
names it, such as `/api/v1/chat/completions` on a
[declared](./providers.md#hosts-of-another-providers-format) OpenRouter as `/v1/chat/completions`.
Either way the call keeps its full path as its name.

**Headers.** A divergence report shows a change to one as `headers.<name>`. A recording that names no
API version, such as one [imported from a trace](./cli.md#traces), matches whatever version the
agent's SDK names.

**Query.** Its parameters are sorted: Gemini's `alt=sse`, Azure's `api-version`, a page cursor.

- **A credential never counts**, such as Gemini's `?key=`. No recording keeps one, so a rotated key
  still replays.
- **A change** shows as `query.<name>`.
- **A recording whose calls to a provider kept no query**, made before calls kept one or imported from
  a trace, matches whatever query a replay sends.

**Body.** Each number counts as the agent wrote it: an id past 2^53 by its digits, so two that a
double rounds alike are two requests. A recording made before requests kept their numbers is matched
with them rounded, as it stored them.

Two built-in exclusions exist:

- **`cache_control` markers**, which the provider documents as behavior-neutral;
- **the session identifier** Claude Code (and so the Claude Agent SDK) sends as `metadata.user_id`,
  which it makes anew for every session and which is no part of the prompt. Another agent's `user_id`
  counts.

**Multipart uploads.** A multipart upload (an audio transcription, a file upload, an image edit) is
read as its parts, not its bytes: each part's name, filename and content type, a field's text, and a
file's SHA-256. So the random boundary its client picks for every request doesn't count, and a
divergence report shows a changed part as `$.multipart[n]`. The upload is stored and sent upstream as
it was.

### The occurrence

The **occurrence** is *n* for the *n*-th call in the run with the same kind and fingerprint, counted
within the call's [scope](./sdk.md#scopes) when the recording has scopes. The third identical
`read_file("config.json")` matches the third recorded one.

### Arrival order

Arrival order is never part of the identity. Parallel tool calls (`Promise.all`, `asyncio.gather`)
interleave differently on replay, because replayed responses return instantly, and they still match.

The one known limit: identical requests issued *concurrently* (say, two sub-agents that start with the
same prompt) may receive each other's recorded responses. The set is right; the assignment is not
guaranteed. Run each branch in a [scope](./sdk.md#scopes) and each keeps its own answers. Within one
scope the limit remains, which only matters when the identical requests' answers are used differently.

Around a fork, arrival order does matter, and only there. Calls that reach shadowlap before the first
changed call are still served from the recording; calls after it follow the fork policy.

So when a turn issues a changed `read` and an unchanged `write` concurrently, the write is either
replayed (its recorded result, nothing re-sent) or blocked, depending on which request arrives first.
A side effect is never repeated in either case. When the order has to be deterministic, issue the
write after the call it depends on, which is what an agent that emails *about* search results does
anyway.

## The replay state machine

A replay is `REPLAYING` until the first call whose key has no unconsumed recorded counterpart, then
`DIVERGED`. The one exception: a plain read (a clock read, a random value, a `pure` tool's call) that
has none is answered live, and the replay stays `REPLAYING`.

```text
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

### The divergence report

A changed request is compared with the closest of a few recorded calls of its kind and name: in its
scope when it has one, nearest its place in the run, the earliest one it could be always among them.

The report shows the diff against it, with hints for what to mask. Both are read as they were
matched: dates near either run's start, a form's parts, a Gemini conversation's made-up call ids by
the order they first appear.

The comparison runs once the call has been answered and before the run ends, so a fork of a long run
never holds the agent's calls up. At the fork of a 1,000-call run whose requests carry about half a
gigabyte of conversation, the changed call is answered in milliseconds.

### Extra reads

A plain read changes nothing outside the agent. So one the recording never held (an agent changed to
log a timestamp, to tag a request with a fresh id) is no change to what the agent did. It runs live,
and every call after it is still matched against the recording.

What the agent does with the value shows in the next request that carries it, which is matched as
strictly as ever. So a timestamp that reaches a prompt still forks there.

Every extra read is reported:

- the run marks each one (`extraRead` on the call);
- its summary lists them:
  `2 extra reads answered live, with no recorded counterpart: #3 clock now, #4 random uuid`;
- `shadowlap test` counts them on the golden's line;
- a later divergence names those before it, since one of their values may be what changed its
  request.

Leftover reads are the other side of the same rule: a replay that never makes a recorded clock, random
or pure read hasn't ended early.

Not every extra call is a plain read:

- **An extra `read` tool call** still forks, since what it returns may have changed in the world, and
  so does an extra `write`.
- **A plain read a flag forces live** (`--diverge-at`, `--live-tool`) forks as before.

### Prefix semantics

Once diverged, every later model call and `read` tool runs live, so live results never mix with stale
reads of a world that may have changed. `pure` tools are the exception: a pure result is a function of
its arguments by declaration, so matching pure calls are still served from the recording.
`--reads replay` extends that to `read` tools for offline forks, with the staleness caveat.

### Retries

The official SDKs retry 408/409/429/5xx themselves and mark each attempt with
`x-stainless-retry-count`. Attempts are stored under one call. Replay serves the final outcome, so
replays never repeat backoff waits.

- **Non-retryable errors** (a 400) are stored as the outcome and replayed as-is, so the SDK raises the
  same typed exception it raised during recording.
- **Identical requests in flight at once** (best-of-n sampling) keep a call each. A retry goes to the
  oldest identical call whose last attempt failed and that has nothing in flight.

### Failures on the way

What happens to a call that failed on its way, and how a replay plays it:

| What happened | How it is recorded | On replay |
|---|---|---|
| The agent left before its answer was whole | A retryable disconnect, with how long the agent waited | The SDK's retry is the same call, and the replay serves the answer the agent got |
| The agent gave up and never made the call again | The same | What had arrived, then the connection held as long as the agent waited, and closed |
| The provider cut a stream part way | The stream as it arrived | The stream breaks at the same place |
| A host can't be reached, or breaks off | No answer, and why | The connection breaks again |
| The sidecar answered the call itself | The answer's bytes and headers | The very same answer |

**An agent that leaves** before its answer is whole (its SDK timed out, or it stopped reading a
stream) ends the request upstream with it, so nothing runs on unseen. A call to a
[declared HTTP host](./sdk.md#http-services-without-wrapping) that the agent gave up on is recorded
the same way.

**A call given up on for good** is replayed as it went: what had arrived, then the connection held for
as long as the agent waited then, and closed without the rest. So an agent whose client gives up as
soon times out as it did, and one that would wait longer sees the connection cut where it was.

**A cut stream** reaches the agent as it arrived and then breaks, as it would without shadowlap.

**A provider or a declared HTTP host** that can't be reached, or that breaks off before its answer is
whole, breaks the agent's connection the same way (an HTTP/2 stream is reset). Its client reports a
connection error and retries as it would without shadowlap. The call is recorded with no answer and
why, and the run's summary names the host.

One break isn't the host's own: an HTTP/1.1 connection shadowlap kept from an earlier call, closed by
the host just as the next call goes out on it. That call goes once more, on a fresh connection.

**An answer the sidecar gives itself** is recorded with its bytes and headers. It answers a call an
offline replay can't serve, a call with a placeholder key or an intervention it can't take, a failure
`--fail-at` plays in, and a write blocked after a fork.

### Forcing divergence

Changing a tool's implementation doesn't change its call key, so a fixed tool would keep replaying its
old result.

- **`--live-tool <name>`** forces its first call live, and every call of it after a fork.
- **`--diverge-at <n>`** forces call *n*.

The SDKs record a hash of each tool's source, and the report warns when it changed since the
recording.

## Effects

Tools declare what they do to the world outside their arguments:

| Effect | Recording | Replay, before divergence | Replay, after divergence |
|---|---|---|---|
| `pure` | execute, store | serve recorded; one with no recorded counterpart runs live and the replay goes on | serve recorded when identical, otherwise execute |
| `read` | execute, store | serve recorded | execute live (`--reads replay` serves recorded matches) |
| `write` | execute, store | serve recorded (never executed) | `block` (default, throws `ShadowlapWriteBlocked` into the agent), `stub` (returns `onFork(args)`), or `allow` |

`effect` is required. The only safe default would be `write`, and making that implicit would hide a
decision the developer must make.

## Tools shadowlap did not record

A recording keeps every model answer, and each answer names the tools the model asked for: Anthropic's
`tool_use`, OpenAI's `tool_calls`, the Responses API's `function_call`, Gemini's `functionCall`.

- **A tool the agent wraps** leaves a call of its own in the run.
- **One it doesn't wrap** (a framework's tool, a built-in such as the Claude Agent SDK's `Bash`, an MCP
  server reached without [`shadowlap mcp`](./mcp.md)) ran in the agent unseen. A replay, which serves
  the answer that asked for it, runs it again for real.

shadowlap reads the run for these, so it finds tools a scan of the code misses:

```text
! The model called 2 tools shadowlap did not record: they ran in your agent unseen, and a replay runs them for real
    lookup_kb  3 calls from model call #2 · "lookup" only looks
    Bash       14 calls from model call #3 · a Claude Code built-in that runs a command
  Bash writes, so every command that replays the run refuses to run it again until it is recorded, declared a read, or allowed with --allow-unrecorded.
```

### How they are listed

`run` and `replay` name them at the end, and `show` above the timeline. `show --json` and
`--summary-json` list them as `unrecordedTools`, each with these fields:

| Field         | Type    | Meaning                          |
|---------------|---------|----------------------------------|
| `name`        | string  | The tool's name                  |
| `count`       | integer | How often the model asked for it |
| `firstCallNo` | integer | The model call that first did    |
| `effect`      | string  | `write`, `read` or `unknown`     |
| `why`         | string  | Why it has that effect           |
| `fix`         | string  | How to have it recorded          |

`fix` is one of these:

| `fix` | For | How it is recorded |
|---|---|---|
| `fence` | A Claude Code built-in the Claude Agent SDK's fence records as it is | Through the fence |
| `fence-effects` | Another Claude Code built-in that writes | Through the fence, once its `effects` name it |
| `mcp` | An MCP server's tool | Through `shadowlap mcp`, or `withEffects` for a server in the agent's own process |
| `none` | A Claude Code built-in that keeps to its own session | — |
| `wrap` | Anything else, another agent's tool of a built-in's name too | Wrapped |

An MCP tool the model calls by its server's prefix (`mcp__kb__search_kb`) counts as recorded when
`shadowlap mcp` recorded it under its own name. A tool the provider runs itself (web search, code
execution, its MCP connector) answers inside the response and runs nowhere in the agent, so it is never
listed.

### A tool's effect

A tool's effect is, in order:

1. **What `tools.unrecorded` in `shadowlap.config.json` declares.**
2. **A built-in's.** Claude Code's, in a run from Claude Code, as below. Computer use, Anthropic's bash
   and text editor, and the Responses API's shell and `apply_patch` write.
3. **Its name's**, as [`shadowlap init`](./cli.md#init) suggests effects, as below.
4. **Else unknown.**

**Claude Code's built-ins.** A run is from Claude Code when a model call came with its user agent
(`claude-cli/…`) or with its session identifier in `metadata.user_id`, or when the Claude Agent SDK's
fence said hello for it. Its built-ins have the effects Claude Code's
[tools reference](https://code.claude.com/docs/en/tools-reference) gives them:

| Effect | Built-ins |
|---|---|
| Write: they run a command, change a file or send something out | `Bash`, `PowerShell`, `Monitor`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `TaskStop`, `EnterWorktree`, `Artifact`, `PushNotification`, `RemoteTrigger`, `SendMessage`, `SendUserFile` |
| Read: they only look, or keep the session's own state | `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `LSP`, `Skill`, `AskUserQuestion`, `TodoWrite`, the `Task` list tools, `EnterPlanMode`, `ExitPlanMode`, `ToolSearch` |
| They start subagents, whose own tool calls are named apart | `Agent`, `Workflow` |

**A tool's name.** Read as `shadowlap init` reads names:

- **A verb that changes something writes** where a name puts its verb: first, or after `and`, `or` or
  `then` (`send_email`, `open_pull_request`, `search_and_book`, `get_or_create_user`).
- **The nouns after a verb that only looks** name what it reads (`get_merge_request`,
  `get_deploy_status` and `lookup_order` read).
- **A name that leads with a noun** puts its verb last (`ticket_status_update`, `browser_click`),
  where a word that is as often a noun (`order`, `run`) doesn't count.
- **A tool that runs SQL**, or a language like it, that the model writes can write (`sql_db_query`),
  since its input decides what it does.
- **Then a word that only looks** makes a read (`get_weather`).

In another agent's run, a tool named as a Claude Code built-in is the agent's own, read by its name
like any other. A plain Node agent's `TaskCreate` and `CronCreate` write, and its `Skill` is unknown,
so a replay refuses them until they are wrapped or declared.

### Which commands refuse

Every command that replays a recording refuses one whose unrecorded tools include a write, or a tool
of unknown effect, before anything runs. It names each, and exits with status 2. A tool of unknown
effect may write, as the MCP proxy takes a tool its server doesn't annotate for one.

These refuse:

- `replay` (with `--repeat` and `--chaos` too), `test`, `blame`, `verify`, `repair`, `calibrate`,
  `bisect` and `injection`;
- the verify of `decisions --then-verify` and of `migrate`;
- `tasks serve`, which answers the request with the refusal;
- a [recorded test](./testing.md#how-it-works) under the pytest, Vitest, Jest and node:test plugins,
  which `SHADOWLAP_ALLOW_UNRECORDED` lets through as `--allow-unrecorded` does.

`decisions --from-code` and `tasks score` leave such a run out and say why.

### Have it recorded, or declare it

Have the tool recorded and replayed:

- **Wrap it** where the agent runs it.
- **A Claude Code built-in**: run the query through the Claude Agent SDK's
  [fence](./frameworks.md#claude-agent-sdk). It records `Bash`, `Write`, `Edit`, `MultiEdit`,
  `NotebookEdit`, `Read`, `Glob`, `Grep`, `WebFetch` and `WebSearch` as it is, and any other once its
  `effects` name it.
- **An MCP server's tool**: connect your agent to the server through [`shadowlap mcp`](./mcp.md). For
  a server in the agent's own process (`createSdkMcpServer`, `create_sdk_mcp_server`), wrap its tools
  with `withEffects` (`with_effects`) as the [Claude Agent SDK](./frameworks.md#claude-agent-sdk) page
  shows.

If running it again is safe, declare it a read:

```json
{ "tools": { "unrecorded": { "Bash": "write", "lookup_kb": "read" } } }
```

Or let one command run it anyway: `--allow-unrecorded Bash` (names separated by commas, repeatable),
which every one of them but `decisions` and `tasks score` takes. A read is only named.

A partial recording, such as an [import](./cli.md#import), holds a trace's model calls and the tools it
kept, and runs every other tool live by design, so it is never refused.

### Tools a fork runs unrecorded

A fork's model answers live, so it can ask for a tool the recording never called. An agent that runs
that tool itself, unwrapped, runs it for real. Nothing refused it up front, since the recording held no
call of it, and nothing stubs it, whatever `--writes` does to the writes shadowlap records.

So every attempt says what it ran unrecorded:

- blame's, verify's and repair's on their lines (`· send_email ran for real, unrecorded`), and in
  their JSON, as each attempt's `unrecordedTools`;
- once after them all, each tool with how often and in how many attempts.

`replay --repeat` counts every attempt's, not the first one's alone.

## The network guard

Only calls that go through shadowlap can be replayed. A tool that isn't wrapped (a direct database
client, a raw `fetch`) would execute during a replay with nothing to say so.

The guard closes that hole without code changes. `run`, `replay`, `test` and every command that
replays an agent preload a small module into the agent process. It intercepts every outbound
connection and every UDP datagram the process sends:

| Runtime        | How the guard loads                                      |
|----------------|----------------------------------------------------------|
| Node           | `NODE_OPTIONS --import`, which needs Node 18.18 or later |
| Python         | A `sitecustomize` on `PYTHONPATH`                        |
| Other runtimes | They ignore both                                         |

The sidecar is allowed, and so is a
[`shadowlap mcp --listen`](./mcp.md#under-the-network-guard) proxy of yours that records the agent's
tool calls, once it proves it is running when the agent connects. Anything else is a side effect
shadowlap cannot replay:

| Mode | What happens | Default for |
|---|---|---|
| `--guard warn` | The connection proceeds, a one-line warning names the host on stderr, and the run summary lists every bypassing target with a count | `run` and `replay` |
| `--guard block` | The connection is refused before any bytes leave, with an error the agent can catch (`ESHADOWLAP` in Node, `OSError` with `EPERM` in Python) | `shadowlap test` |
| `--guard off` | Nothing is intercepted | — |

The guard also runs during recording, so a recording's summary already tells you which hosts your
agent talks to outside shadowlap, before you ever replay. The run keeps the list too, for its page in
the [dashboard](./dashboard.md#what-a-runs-page-is-worked-out-from).

### Allowing a target

- **`SHADOWLAP_GUARD_ALLOW=host:port,host:port`** whitelists targets you accept (a local database in
  development, for example).
- **Unix sockets and pipes** are local IPC and always allowed.

Node names a target by the host the agent asked for. Python connects to the address a name resolved
to, so its guard names a target by the names that resolved to that address (`api.stripe.com:443`, not
the address). When several did, as behind a CDN or a shared load balancer, the address is shown with
all of them: `104.18.7.1:443 (api.example.com, cdn.example.com)`.

Those hosts can't be told apart when the connection opens. So an allowed host name lets a Python
connection through only while every name that resolved to its address is allowed. Allow the address
itself (`104.18.7.1:443`) to let them all through.

### What it sees

| Runtime | Connections | UDP |
|---|---|---|
| Node | every TCP connection, through `net.Socket`: `net`, `tls`, `http`, `https`, `http2`, `fetch` and `WebSocket` | `dgram` sends and connects |
| Python | `socket.connect` and `connect_ex`; asyncio's selector loop, which connects through them, its proactor loop (Windows' default), which doesn't, and uvloop | `sendto`, `sendmsg` and `connect` on a datagram socket, asyncio's datagram endpoints and transports, and uvloop's |

- **The proactor loop and uvloop** are guarded when the agent first imports them, so an agent that
  never does pays nothing.
- **A UDP target** is listed once per process as `udp://host:port`, however many datagrams went to
  it. Under block every one is refused, as a failed send reaches it: through the send's callback or
  `error` event in Node, as `OSError` from the send in Python, or through a datagram protocol's
  `error_received`.
- **A name lookup** through `getaddrinfo`, which Node's `dns.lookup` and Python's resolver both use,
  makes no connection the guard sees. A DNS query a client sends itself (UDP to port 53) is left
  alone: a lookup reads nothing of yours and changes nothing.

### Knowing it loaded

A guard that never loaded can't say anything, so each Node and Python process says when its preload
has. It says so once, to the sidecar, with its runtime and process ids, the guard it set up and whether
in-process capture is on.

A run that made model or tool calls with no such word from any of its processes was never watched.
Its summary says so, with the likely cause:

- the agent runs on a runtime with no preload (Go, Rust, Java, and Bun or Deno, which the summary
  names when the command shows them);
- a launcher reset its environment (`env -i`, `sudo`, `docker exec`);
- a script set `NODE_OPTIONS` or `PYTHONPATH` anew;
- Python ran with `-I`, `-E` or `-S`;
- `opentelemetry-instrument` put its own `sitecustomize` first.

A run is just as unwatched when one of its processes says it runs with the guard off:

- **a preload whose guard couldn't start;**
- **the Claude Code CLI** the [Claude Agent SDK](./frameworks.md#claude-agent-sdk) runs, a native
  program no preload loads into. The SDK's fence says so for it, with what the CLI can still reach:
  with none of it left, the run passes.

What each mode does with a run the guard couldn't watch:

| Mode            | A run the guard couldn't watch                                                                   |
|-----------------|--------------------------------------------------------------------------------------------------|
| `--guard block` | Fails with that line: `shadowlap test` fails its golden, and `shadowlap replay` exits 1          |
| `--guard warn`  | The summary names them all, and says a connection that bypassed shadowlap could have gone unseen |
| `--guard off`   | Expects nothing                                                                                  |

- **To accept a run the guard can't watch**, replay it with `--guard warn` (the GitHub Action's `guard`
  input).
- **`guard.accept`** in the config (`["claude-code"]`) accepts the Claude Code CLI as it is, keeping
  block for every Node and Python process.
- **The summary of a run that failed for the guard alone** says it was not watched, not that its agent
  exited with an error.

The run keeps how many processes of each runtime loaded the preload, and `shadowlap doctor` explains
the newest run whose agent had none.

### What it can't see

The guard sits in the runtime's own network layer, so what bypasses that layer bypasses the guard:

- **Libraries that open sockets in C.** libpq (under `psycopg` and `psycopg2`), `mysqlclient`,
  `grpcio`, `confluent-kafka` and Node's native addons such as `pg-native` connect from their C code,
  out of its sight. A database write through one runs on every replay, under `--guard block` too, and
  no summary lists it.
- **Processes without its environment.** A child started with a minimal environment (a stdio MCP
  server, `env -i`, `sudo`, a container) loads no preload; [`shadowlap mcp`](./mcp.md) records an MCP
  server's tool calls instead. A worker thread started from a string of code
  (`new Worker(code, { eval: true })`) loads none either; one started from a file does.
- **What isn't the network.** File writes, a subprocess's own effects and anything else local are no
  connection: wrap them as tools too.

For a C library, wrap its calls as tools (`tool()` in the TypeScript SDK, `@shadowlap.tool` in Python)
with a `write` effect, so they are recorded, replayed and fenced after a fork. Or, in development,
point them at a local instance you are happy to see written to. Pure-language clients (`asyncpg`,
`pymongo`, `redis`, `pg`, `mysql2`) connect through the runtime and are seen.

## Keys

A live call carries your key: the sidecar forwards it upstream and never stores it. What a recording
answers needs no key. But a model client built the default way (`new Anthropic()`, `new OpenAI()`,
Google's `GoogleGenAI` or `genai.Client()`) reads its key from the environment and refuses to send
anything without one.

So a replay gives the agent a placeholder for each provider its recording called when the environment
has no credential for it, and the client sends what the recording answers:

| Provider | Placeholder |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY=shadowlap-offline-replay-placeholder` |
| OpenAI | `OPENAI_API_KEY=shadowlap-offline-replay-placeholder` |
| Gemini | The same value in `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY`, or in the one of them the recording's environment held |
| Azure OpenAI | `AZURE_OPENAI_API_KEY=shadowlap-offline-replay-placeholder`, only when the recording's environment held `AZURE_OPENAI_API_KEY` |
| Azure OpenAI, through the AI SDK or LiteLLM | `AZURE_API_KEY`, which the AI SDK's Azure provider and LiteLLM read, only when it held that |
| Bedrock | `AWS_ACCESS_KEY_ID=SHADOWLAPREPLAY` and `AWS_SECRET_ACCESS_KEY=shadowlap-offline-replay-placeholder` |
| Vercel's AI Gateway | `AI_GATEWAY_API_KEY=shadowlap-offline-replay-placeholder` |
| Claude on Microsoft Foundry | `ANTHROPIC_FOUNDRY_API_KEY=shadowlap-offline-replay-placeholder`, only when the recording's environment held `ANTHROPIC_FOUNDRY_API_KEY` |
| OpenAI's SDK on Bedrock | `AWS_BEARER_TOKEN_BEDROCK=shadowlap-offline-replay-placeholder`, only when the recording's environment held `AWS_BEARER_TOKEN_BEDROCK` |

`GOOGLE_GENERATIVE_AI_API_KEY` is the one the AI SDK's Google provider, and Mastra's model router,
read.

### What counts as a credential

A placeholder never replaces a credential you set, of any kind the provider's SDKs read:

| Provider | Credentials a placeholder never replaces |
|---|---|
| Anthropic | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID` or the active Anthropic profile |
| OpenAI | `OPENAI_ADMIN_KEY` |
| Azure | Microsoft Entra ID: `AZURE_OPENAI_AD_TOKEN`, `AZURE_CLIENT_ID`, `AZURE_FEDERATED_TOKEN_FILE`, a managed identity's `IDENTITY_ENDPOINT` or `MSI_ENDPOINT` |
| AWS | `AWS_PROFILE`, a profile in AWS's shared credentials or config file that holds credentials, `AWS_WEB_IDENTITY_TOKEN_FILE`, container credentials or a Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) |

- **The active Anthropic profile** is in `ANTHROPIC_CONFIG_DIR`, `$XDG_CONFIG_HOME/anthropic` or
  `~/.config/anthropic`.
- **An AWS profile holds credentials** when it holds keys, a `credential_process`, an SSO session, a
  role to assume, or web identity.
- **Not a credential**: a shared file whose profile holds none, such as a config file that names only a
  region. Nor is an Azure CLI sign-in, which the clients never read; a token provider the code gives
  them would.
- **An empty variable**, which is what a pull request from a fork gets for a secret, counts as none.

Some providers get a placeholder only sometimes, or never:

- **Azure OpenAI and Claude on Foundry** get one only for a recording whose environment held the key
  itself: their Node clients refuse a key beside a token provider, which no variable shows.
- **Vertex AI clients** fetch a token before they call it, which no placeholder stands in for
  ([Providers](./providers.md#credentials-on-replay)).
- **With `SHADOWLAP_CAPTURE=off`**, Azure OpenAI, Bedrock and the hosts of another's format (Claude on
  Foundry, OpenAI's SDK on Bedrock) get none, since their calls would then go straight to the
  provider.

### A placeholder is never sent

A placeholder is never sent, to any host: a provider, a gateway, a model server on this machine or a
mock. The sidecar answers a live call that carries one, in any header, in an AWS signature or in the
query string, with one line instead of sending it:

```text
a live call needs a real key: set ANTHROPIC_API_KEY, or keep the replay offline
```

The agent gets it as the provider's own 401 (`UnrecognizedClientException` from Bedrock). The
replay's summary prints it under the fork line, which counts the call as refused, not as an upstream
request.

A call to a host declared under `http` that passes one on, such as a vector store that embeds with the
caller's OpenAI key, is answered the same way, the line naming the call.

### Offline and live commands

**Offline.** None of these needs a key:

- a clean replay;
- `shadowlap test` and the [GitHub Action](./ci.md#github-actions), but for `--online`, a golden
  marked `fork` and a gate with `fork: true`;
- [recorded tests](./testing.md) under pytest, Vitest and node:test;
- `bisect` without `--fork`;
- `calibrate`;
- `coverage --pack`;
- the replay `decisions --from-code` reads the working tree's prompt with;
- `check`, and the checks `verify` reads from a recording, which run nothing.

Each replay gets a placeholder for every provider its recording called whose credential the
environment lacks (Azure OpenAI's as above). A call the recording doesn't hold fails as offline, never
live. A recorded test's process holds them only while the test runs, each where its variable is empty,
and has the variable back as it was afterwards.

**May go live:**

- a fork, whether the code changed a request or a flag did (`--inject`, `--set`, `--model`,
  `--override`, `--fail-at`, `--inject-result`, `--prompt-from`, `--diverge-at`);
- `--live-tool` and `--live-input`;
- `test --online` and `--update`, a golden marked `fork` and a gate with `fork: true`;
- `--chaos`;
- the attempts of `blame`, `verify` and `repair`;
- `injection`, `bisect --fork`, `decisions`, `migrate` and `tasks score`;
- a judge asked live.

A live call needs a real key, and none of these gives a placeholder but `shadowlap replay`.

**`shadowlap replay`**, with `--repeat` and `--watch` too, is offline until it forks:

- **It gives its agent a placeholder** only for a provider whose key the recording's own environment
  held, which a run keeps by name, never by value (`keyEnv` in its
  [metadata](./recording-format.md#a-run)).
- **That agent took its key from the environment then**, so a clean replay needs none, and a fork stops
  at its first live call with the line above.
- **An agent that brings its key itself** (from a `.env` file it loads, or a local server's `ollama`)
  or signs in another way (a token provider, an instance role) gets none, so its fork goes live with
  what it has.
- **A recording that doesn't say**, such as an import, gets none.

## Where forks happen

A replay forks at the first **request** that changes, not where the bug is. That splits changes into
three classes:

1. **Changes that alter no request.** Response parsing, tool dispatch, state management, stop
   conditions, error handling, logging: the harness around the model. These replay end to end at zero
   cost against the model's exact recorded behavior. A large share of agent bugs live here.
2. **Changes that alter late requests.** A sub-agent prompt first used at call 20, a tool whose fixed
   result changes call 9, a different tool result injected at call *k*. The unchanged prefix replays;
   the suffix runs live with writes fenced.
3. **Changes that alter every request.** The top-level system prompt and tool definitions are sent
   with every model call, so editing them diverges at call 1. shadowlap still provides the diff, a fork
   whose writes are fenced, and the lineage, but no token savings. No design can serve a recorded
   response to a request the model never saw.

Class 3 is why [interventions](./interventions.md) exist, and why the [decision diff](./decisions.md)
does: it asks each recorded model call again with only the changed prompt or model, so the change's
effect on every step shows before a live run of anything.

### State kept on the provider's side

OpenAI's Responses API can keep a conversation for the agent. A request continues one by naming the
response it follows (`previous_response_id`) or a conversation (`conversation`).

A replay serves the recorded responses, so a fork's first live call names a response the recording
made. OpenAI holds that only for the key and organization that made it, only for as long as it keeps
responses, and never for one made with `store: false`.

Such a call is sent with the whole conversation it continues instead, rebuilt from the recorded
requests and their answers. Each turn's input goes, then its output, as the stateless Responses
pattern sends them. A reasoning item goes along when it carries its encrypted content, and is left out
when only OpenAI's side can read it. The run's summary says which call was sent so. Its recording keeps
the request as the agent sent it, so a replay of the fork matches it.

A call that names a conversation the recording used is refused instead, with OpenAI's error shape and
a line in the summary. The conversation holds every turn of the recorded run, those after the fork
too, so the model would read what the agent hasn't done yet. Fork from the call that made the
conversation (`--diverge-at`), and the fork makes its own.

### Caches, files and vector stores

The same holds for a context cache, an uploaded file and a vector store. Each is kept only for whoever
made it:

| What | Kept only for | And only |
|---|---|---|
| A context cache (`cachedContent`), on the Gemini API or Vertex AI | The project that made it | For its time to live, an hour by default |
| A file uploaded through OpenAI's, Anthropic's or Gemini's Files API | The organization, workspace or project that uploaded it | Gemini's for 48 hours |
| A vector store | The organization that made it | — |

A fork's live call that names one the recording made is sent with what it names in its request
instead:

- **A cache**: the cache's system instruction, tools and contents, rebuilt from the recorded call that
  made it.
- **A file**: the file's bytes in its place, from the recorded upload, as long as the request then
  stays within what its provider takes.

The file's bytes go in the provider's own shape:

| Part                                  | Sent as         |
|---------------------------------------|-----------------|
| An OpenAI `input_file` or `file` part | `file_data`     |
| An `input_image`                      | A data URL      |
| An Anthropic document or image        | A base64 source |
| A Gemini part                         | `inlineData`    |

What a provider takes is counted in base64, as the request carries it:

| Provider          | Limit                              |
|-------------------|------------------------------------|
| Anthropic         | 32 MB a request, and 5 MB an image |
| OpenAI and Gemini | 50 MB                              |
| Azure OpenAI      | 20 MB                              |

Some can't be carried in its place:

- **A file the recording holds no whole copy of** (uploaded in parts, or around shadowlap) is sent as
  it was, and the summary says it fails with another account's key.
- **What a request names by its id alone** gets the same line, with no way to carry it in its place: a
  file in a code interpreter's `file_ids` or Anthropic's `container_upload`, and a vector store a file
  search names (`vector_store_ids`). Each comes with the call to fork from to make it again.
- **A file Gemini has already deleted** is refused, in Gemini's error shape, naming the upload to fork
  from.

Each line names the call and what was sent in its place, and the fork's recording keeps the request
as the agent sent it.

## Partial recordings

A recording made by `shadowlap run` contains every call the agent made: model calls, tool calls,
clock reads and random values. A recording built from traffic something else captured contains only
what crossed the network. It is a **partial recording**, and it says so: `meta.covers` lists the
call kinds it holds.

This matters because of how divergence works. A replay diverges when a call has no match in the
recording, which is exactly right when the recording should have had one, and exactly wrong when it
never could. Most agents read the clock or call a tool before their first model call, so without
this distinction a capture of the network would fork at call 1, every time.

So a replay of a partial recording:

- serves the kinds it covers from the recording, matched as strictly as ever;
- runs every other kind **live**, without ending the replay;
- still fences write tools according to `--writes`, because a live write is a real side effect
  whether or not the recording expected it.

Two consequences worth knowing:

- **Values the agent generates leak back in.** With the clock and randomness running live, a request
  id or timestamp the agent puts into a prompt differs from the capture and forks the replay. The
  report names it and suggests the [normalizer](./normalizers-and-redaction.md); that is the usual
  first step after an import.
- **Replaying a partial recording produces a complete one.** The model calls come from the capture and
  everything else is recorded live, so the resulting run covers everything, which is what you pack as
  a CI golden. An imported HAR is the start of a recording, not the end of one.

`shadowlap import` sets this. The mechanism is general: any source that sees some kinds and not others
describes itself the same way. A [trace](./cli.md#traces) can hold some tools' calls and not others':
it lists each tool whose every call it kept as `tool:<name>` (`["api", "tool:lookup_order"]`), and
those calls replay while every other tool runs live.

## Thinking blocks

Current Claude models bind each thinking block to the model that produced it and to the conversation
prefix that produced it: the top-level `system`, the `tools` set and every earlier message. Editing any
of those in a later request invalidates every later block. On organizations created on or after
2026-08-31 the request is rejected unless it opts into dropping the blocks.

Forks are compatible by construction: the history before divergence is exactly what was recorded, and
nothing edits it. Interventions are designed around the same rule:

- an override changes only content after the last recorded block;
- an injection is appended and then kept at the same position;
- parameter patches touch fields that aren't bound.

"Rewind to step 15 and change the prompt" is therefore an *addition* at step 15, not a change to what
steps 1–14 saw.

## Storage

Local-first: `.shadowlap/shadowlap.db`, one SQLite file in WAL mode, created with a `.gitignore` so
recordings stay out of version control.

- **Runs** carry mode (record or replay), status, lineage (`parent_run_id`), the divergence report, the
  command, and the git revision.
- **Call events** are append-only: a `start` row when a call is resolved and an `end` row when it
  completes, so a crash leaves a visible pending call rather than a half-written record. Retries are
  extra end rows.
- **Blobs** are content-addressed by SHA-256. Every model request resends the whole conversation, so
  whole-request blobs would never deduplicate. A request is stored as a manifest that references its
  system prompt, its tools and each turn of its conversation separately: Anthropic's and Chat
  Completions' messages, Gemini's contents, the Responses API's input items. A 30-call run stores 77
  unique chunks, not 11 full copies.
- **Responses** are stored raw (JSON or SSE bytes) with status, filtered headers and per-event timing,
  which is what makes the TUI's play mode possible.

Every run is self-contained: a replay stores a row for every call, including replayed ones, pointing
at the same blobs. Reading a fork never requires stitching a parent onto it, and deleting a parent
doesn't break its children. [`shadowlap pack`](./cli.md#pack-unpack) exports a run as a git-friendly
directory.

### Cached fingerprints

The fingerprints a replay matches by are cached with the dates each request holds, in its query too,
read decoded as its fingerprint reads them. They are keyed by the request and every rule that went
into them: the fingerprint version, normalizers and redaction rules, the clock setting, the query.

The recording fills the cache, so a replay of a 1,000-call run starts in well under a second however
large its requests. A replay whose start masks a request's dates differently works that fingerprint
out again, and `gc` drops the entries of requests it deletes.

### Writes never hold an answer up

When another process holds the store (the dashboard, `gc`, another recording), a run's start and end
and its calls' rows wait their turn, in order. They are written once it is free, so another run's
stream goes on as it came. A run's end waits for none of them: its summary comes from the calls as the
sidecar kept them.

Where runs go on side by side, a command that reads its run's calls waits for their rows on the
writer's timer, never on the thread:

- an attempt checking itself, asking its judge or counting its calls, as `blame`, `verify` and
  `replay --repeat` run them;
- a test's recording listed or saved through `serve --recordings`.

A read made straight through the store takes what this process queued for that run first, waiting for
it on the thread while the store is held. A replay's start does so to read a run this process has just
recorded.

A row that still can't be written after 10 seconds is kept as an error end where it can be, and the
run's summary says so. `run`, `replay` and `test` wait for a run's rows once it has ended, and their
summary adds what could not be written. A run's own end is tried for as long as the store is held
while the command lasts, so a command never leaves its run reading as running for want of it.

## See also

- [The recording format](./recording-format.md): packs, identity and the recordings protocol.
- [Interventions](./interventions.md): change one thing at one call, and replay the rest.
- [Providers](./providers.md): in-process capture, and hosts of another provider's format.
- [Normalizers and redaction](./normalizers-and-redaction.md): masking what changes on every run.
- [Why did my replay diverge?](./troubleshooting.md): reading a divergence report.
