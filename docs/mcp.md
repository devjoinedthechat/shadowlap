# MCP servers

Agents increasingly call tools through the Model Context Protocol rather than through code you wrap.
`shadowlap mcp` records those calls without touching the server or the client. It is a proxy that
the client starts instead of the server, and talks to over stdio as it would to the server. For a
client that speaks HTTP, it is one the client connects to at a local address
([`--listen`](#served-over-http---listen)).

## Put a server behind the proxy

Put it in front of a local server, started as a command, or a remote one, reached by its URL:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "shadowlap",
      "args": ["mcp", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/srv/notes"]
    },
    "issues": {
      "command": "shadowlap",
      "args": ["mcp", "--url", "https://mcp.example.com/mcp", "--header", "Authorization: Bearer $ISSUES_TOKEN"],
      "env": { "ISSUES_TOKEN": "…" }
    }
  }
}
```

Outside Shadowlap the proxy is transparent, so the same client configuration works with and without
Shadowlap ([outside Shadowlap](#outside-shadowlap)).

## How tool calls are recorded

Every message passes through unchanged except `tools/call`, which goes through the sidecar exactly
like an SDK tool call:

| Case | What happens to the call |
|---|---|
| Recording | It is forwarded to the server, and its result stored under the tool's name and arguments |
| Replay | A call whose arguments match the recording is answered from the recording; the server never sees it |
| After a fork, a `read` tool | It runs live, or replays with `--reads replay` |
| After a fork, a `write` tool | It is refused, or stubbed with `--writes stub` |
| A failed tool (`replay --fail-at <call>=timeout`, `error:<message>` or a status) | The server never sees it; the client gets a tool result with `isError: true` and the failure's message |

- **A refused write** reaches the model as a tool result with `isError: true`. The run summary counts
  these calls like any other tool.
- **A failed tool** reads as when a tool's handler fails. See [fail a tool](./interventions.md#fail-a-tool).
- **Everything else** (`initialize`, `tools/list`, resources, prompts, notifications, and the
  server's own requests to the client) is forwarded as-is, in order.

**Batches.** A JSON-RPC batch that carries a `tools/call` is refused under Shadowlap, because a call
inside a batch could be neither recorded nor fenced. Each request in it gets an error (`-32600`), and
the batch's notifications go on one by one. MCP 2025-06-18 removed batching, and the official clients
don't send batches.

### What a call records about its server

Each recorded call names its server in `meta.mcp`:

- **The transport:** `stdio` or `http`.
- **The server:** its host (`--url`) or its command (`npx @modelcontextprotocol/server-filesystem`).
  Never the arguments after the package, nor a URL's path, since either can hold a key.

The first call to a server in a run, and any call after its tool list changed, also lists the
server's tools with their effects. That list is what the dashboard's MCP table counts.

## A local server, started as a command

```sh
shadowlap mcp -- npx -y @modelcontextprotocol/server-filesystem /srv/notes
```

In front of a command, the proxy runs as long as its server:

- **A stop signal it gets** (Ctrl-C, SIGTERM, or the SIGHUP of a closed terminal) reaches the server
  too.
- **Once the server has exited,** the proxy ends, with 128 + the signal's number, even while the
  client holds its end of the proxy's input open.
- **A server ended by a signal the proxy never got** ends it the same way, with 128 + that signal's
  number (137 for SIGKILL).

## A remote server: `--url`

```sh
shadowlap mcp --url https://mcp.example.com/mcp [--header 'Authorization: Bearer $TOKEN']...
```

The proxy speaks the [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)
to the server:

- Each message from the client is a POST.
- Each answer comes back as JSON or as an event stream, which may carry the server's own messages
  (progress, logs, requests to the client) before it.
- The proxy keeps the session the server gives at `initialize` (`Mcp-Session-Id`), and sends it,
  with the protocol version agreed, on every later request.
- Once the session starts, it opens the server's stream for messages outside any request, when the
  server offers one.
- It ends the session when the client goes away.

A tool call the recording answers, and a write after a fork, never reach the server:
**a remote write never runs again on replay**. That is the difference from listing the server's host
under `http` in the config, which records it as one tool with one effect.

### Headers

- **`--header "Name: value"`** is sent with every request (repeatable). Headers are never recorded.
- **Variables.** `$NAME` or `${NAME}` in a value is read from the proxy's environment, so a token can
  live in the client config's `env` block rather than in its arguments. `$$` is a `$` itself.
- **`https` only.** With headers, the URL must be `https` unless the server is on this machine
  (`localhost`, `127.0.0.0/8`, `::1`): they would cross the network in the clear.
- **`--allow-http`** accepts plain http to another host, for a server on a network you trust.

Some clients fill in `${…}` in their config themselves, from their own environment, before they start
the proxy. Claude Code does in `.mcp.json`, and refuses a config whose variable isn't set there. So
write `$NAME` in the argument, which such a client leaves alone, and give the value in the entry's
`env`:

- in `.mcp.json`, `"env": { "ISSUES_TOKEN": "${ISSUES_TOKEN}" }`, which Claude Code fills in;
- in Cursor's and VS Code's, `"${env:ISSUES_TOKEN}"`.

It then reaches the proxy in its environment, never on its command line. In a terminal, quote the
header with `'…'` for the same reason. The dashboard's Settings → Tools copies each remote server's
headers this way.

### Sessions and errors

- **The server ends the session** (it answers 404): the proxy does what the transport asks of a
  client. It starts a fresh session with the client's own `initialize` and sends the request again in
  it, so the client never notices.
- **The client initializes again** itself: that starts a fresh session too, since an `initialize`
  never carries the earlier session's id.
- **The server can't be reached,** or answers a request with an HTTP error: the client gets an error
  naming it. So it does for an answer the connection breaks off part way, which is never passed on as
  a whole one.
- **A tool call that fails this way** is recorded with that error, so a replay serves the same
  failure without asking the server.

### OAuth and the network guard

A server that signs in with OAuth needs a token: pass one as a header, or put the proxy in front of a
stdio bridge that does the sign-in, such as `shadowlap mcp -- npx -y mcp-remote https://mcp.example.com/sse`.

When the client passes its environment on, the [network guard](./how-it-works.md#the-network-guard)
is loaded into the proxy as into any Node process. The proxy tells it its server's address, since it
records that traffic itself. Only the `shadowlap mcp` process gets that hook, so an agent's own code
can't use it to lift the guard.

## Served over HTTP: `--listen`

An agent whose MCP client speaks HTTP rather than stdio connects to the proxy at a local address
instead of the server's. Such clients include the OpenAI Agents SDK's `MCPServerStreamableHttp`, the
AI SDK's MCP client, and a Claude Agent SDK server of `type: 'http'`.

```sh
shadowlap mcp --url https://mcp.example.com/mcp --listen 127.0.0.1:8931 --header 'Authorization: Bearer $TOKEN'
```

**Note:** The Claude Agent SDK's fence counts a server of `type: 'http'` as one over the network,
which [`--guard block`](./frameworks.md#claude-agent-sdk) fails. Give it `shadowlap mcp` as a stdio
server instead.

The agent's client connects to `http://127.0.0.1:8931/mcp`:

- Each message goes on to the server as the client sent it, in the client's own session (the
  server's `Mcp-Session-Id`, which the client keeps).
- Each answer comes back as the server gave it, JSON or an event stream, event ids included.
- The client's GET stream for the server's own messages, and its DELETE when it leaves, pass through
  the same way.
- `tools/call` is recorded, replayed and fenced as in the other modes: a call the recording answers,
  and a write after a fork, never reach the server.

### This machine only

`--listen` takes a loopback address: `127.0.0.1:8931`, `localhost:8931`, `[::1]:8931`, or a port
alone. A request must name that address in `Host`, and a browser's `Origin` must be that address too,
so a web page can't reach the server through the proxy. Any process on this machine that can reach
the port can, with the `--header` values the proxy holds.

### Which run a session records into

How the proxy was started decides which run a session records into:

| Started | A session records into |
|---|---|
| By a Shadowlap command, or under one (with `SHADOWLAP_URL` set) | That command's run |
| On its own, in a terminal beside the agent | The run of the Shadowlap command that started the connecting process or one of its ancestors |
| On its own, where the system won't say which process connected | The one run active for you |
| On its own, with no run found, or several it can't tell apart | None: it can't be recorded |

Started on its own, the proxy serves one run after another. When a session starts, it asks the system
which process connected: from `/proc` on Linux, `lsof` on macOS, `netstat` on Windows. Every agent a
Shadowlap command starts is registered so, whatever the command
([any that starts an agent](#finding-the-run)), the folder it runs in, and however many of its
attempts run at once.

The one run active for you is read from the runs whose agents are running, and the
`.shadowlap/active.json` in the proxy's folder.

A session that can't be recorded could be a replay. So its write tools are refused, with a tool error
the model sees, and its read tools pass through unrecorded. The proxy says which on stderr.

### Under the network guard

The proxy registers its address while it runs, in `~/.shadowlap/mcp/<its process id>.json`,
owner-only. Every command that starts agents lets them reach each running proxy of yours that
records their tool calls, at its address and at `localhost` with its port. The
[network guard](./how-it-works.md#the-network-guard) neither warns of it nor, under `block`
(`shadowlap test`'s default), refuses it.

How the proxy was started decides whose calls it records, and so whose agents it lets through:

| Started | Lets through |
|---|---|
| On its own | The agents of every Shadowlap command |
| By a Shadowlap command, or under one (by the agent's own command, say) | That command's agents alone, whose run it records into |
| Under a Shadowlap command whose run it can't find | None: it doesn't register |

- **When the agent connects.** The guard reads the folder then, so a proxy started after the agent,
  or by it, counts.
- **It proves it runs.** A registration holds a key the proxy keeps. Before a connection goes on,
  the proxy proves it holds the key, so a file left by a proxy that was killed lets nothing through,
  even once its process id is another process's.
- **Nothing listening.** A connection to a registered address where nothing listens is left to fail
  as it would, as when `localhost` names two addresses and the proxy serves on one.
- **A file that isn't yours alone,** or that names a process that has ended, lets nothing through.
- **The home folder only.** The files are read from there, where no repository can put one.
- **By hand.** Where the home folder can't be written, the proxy says so on stderr. Then, or for a
  proxy started under another user, let it through with `SHADOWLAP_GUARD_ALLOW=127.0.0.1:8931` in the
  command's environment.

### Other behaviour

- **Cut off.** An answer the server breaks off part way ends the call in the recording as an error,
  and the client's response is broken off too (an event stream ends after its last whole event). A
  replay breaks the client's response off again where it was broken off live, rather than answer
  with the error.
- **HTTP errors.** A tool call answered with no MCP message, such as a 503, or the 502 the proxy
  gives when the server can't be reached, ends in the recording as an error that keeps the answer.
  A replay gives the client the same status, body, `Content-Type`, `Cache-Control`,
  `WWW-Authenticate` and `Retry-After`.
- **Headers.** `--header`, `--effect` and `--allow-http` work as with `--url` alone. The client's own
  `Authorization` goes on to the server unless a `--header` sets one.
- **OAuth.** Signing in with OAuth through the proxy isn't supported: pass a token.
- **Stopping.** It runs until it is stopped: a stop signal ends it with 128 + n, 130 for Ctrl-C.

## Effects

MCP tools declare [annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations),
and the proxy reads a tool's effect from them:

| Annotation           | Effect                                                                   |
|----------------------|--------------------------------------------------------------------------|
| `readOnlyHint: true` | `read`                                                                   |
| Anything else        | `write`, because an unknown side effect must not be repeated by a replay |

Override per tool when the server is under-annotated, on the command line or in
`shadowlap.config.json`:

```sh
shadowlap mcp --effect search=read --effect get_page=read -- npx my-server
shadowlap mcp --url https://mcp.example.com/mcp --effect search_issues=read
```

```json
{ "mcp": { "effects": { "search": "read", "get_page": "read" } } }
```

The tool's input schema is recorded as its implementation hash, so a server whose tool schema changed
between recording and replay produces the same warning as a changed SDK tool.

### Untrusted reads

A read tool whose server sets `openWorldHint: true` (it reaches outside entities: a web search, a
mailbox, an issue tracker) is recorded as untrusted, where [`shadowlap injection`](./injection.md)
plants payloads.

- **Only a hint the server sets counts.** MCP reads a missing one as true, which would mark every read
  of a server that annotates nothing.
- **An open-world write** stays a write.
- **In the config,** mark any other tool, or unmark one: `"tools": { "search_issues": { "trust": "untrusted" } }`.
  The config's mark is recorded on the call too (`meta.trustFrom` `config`), and wins over the
  server's.

## Finding the run

Every command that starts an agent sets `SHADOWLAP_URL` and `SHADOWLAP_RUN_ID` for it. Those are the
commands that take `--guard`:

- `run`, `replay` and `replay --repeat`, `test`, `bisect`, `calibrate`, `blame`, `verify`, `repair`
  and `injection`;
- `decisions` and `migrate` when they run one;
- `coverage --pack` when it replays one;
- `tasks score` and `tasks serve`.

The proxy uses them when the client passes its environment on. A test runner's host sets
`SHADOWLAP_URL` alone, naming the run's slot, and the proxy records into that run, as the SDKs do.

But MCP clients usually start servers with a minimal environment: the official SDKs pass on only
`PATH`, `HOME` and a few more. So each of those commands also writes a small file for every agent it
starts, `~/.shadowlap/agents/<the agent's process id>.json`, naming its sidecar and run, and removes
it when the agent exits.

- **The nearest agent's file.** The proxy walks up its own process tree and takes the nearest agent's.
  Attempts running at once never mix: each agent has its own process id.
- **On Windows,** where reading the process tree takes PowerShell, the proxy first looks for the file
  of the process that started it. That is the agent when the agent's own MCP client starts the proxy;
  the proxy reads the tree only when that one has none.

### Which files it trusts

The file carries the sidecar's session token, so the folder is owner-only. The proxy trusts a file
only when it:

- is the user's own, owner-only and not a link;
- names the process it is filed under;
- names that process's parent, the Shadowlap command, correctly (or, found without the tree, names a
  Shadowlap command still running).

A file left behind by a run that was killed is ignored. When the home folder can't be written, the
file goes in the project's `.shadowlap/agents` instead, and the proxy looks there and in every folder
above its working directory.

A file in the home folder that fails the checks makes the proxy fail closed (below). One in a
project's folder, which a cloned repository could carry, is ignored.

### It fails closed

When the proxy was started under a Shadowlap command but can't record, it fails closed. That happens
when no run is registered where it can see, or the sidecar doesn't answer. It then refuses write
tools, with a tool error the model sees, and passes read tools through unrecorded, saying so on
stderr: this may be a replay, and a write must not run again.

Where the process tree can't be read, the proxy falls back to `.shadowlap/active.json`, which
`shadowlap run` and `replay` leave in the working directory while they run. With neither its parent's
registration nor that file there, it can't tell it runs under Shadowlap, and passes everything
through, saying why on stderr.

### Outside Shadowlap

Outside Shadowlap, the proxy a client starts says so once on stderr and becomes transparent, so the
same client configuration works with and without Shadowlap. A `--listen` proxy started on its own is
there for Shadowlap's runs: a session that belongs to none refuses write tools
([above](#served-over-http---listen)).

## What is not recorded

**The server's own work.** A server that fetches URLs or calls APIs does that in its own process, or
on its own host. The recording holds what the *tool returned*, which is what the model saw, and that
is what a replay serves.

**What a local server reaches.** When the client passes its environment on, a local server's process
inherits the network guard too, so connections it makes during a replay show up in the run summary.
Started with a minimal environment, as MCP clients usually start servers, it loads no preload, and
what it reaches goes unwatched.

**The session itself.** On replay the proxy still starts the local server, or opens a session with the
remote one, and forwards `initialize` and `tools/list` to it. Those only read, but the server has to
be there: a replay in CI needs the local server's command to run, or the remote server to be
reachable with its headers.

## Flags

The flags this page covers ([`shadowlap mcp`](./cli.md#mcp) has the synopsis and exit statuses):

| Flag | What it does | Default |
|---|---|---|
| `-- <command>` | Starts a local server from its command, and talks to it over stdio | — |
| `--url <server>` | Speaks Streamable HTTP to a remote server | — |
| `--header "Name: value"` | Sent with every request to the `--url` server; repeatable | — |
| `--allow-http` | Sends headers over plain http to another host | Off: `https`, or plain http to this machine |
| `--listen <address>` | Serves the `--url` server over HTTP at a loopback address | — |
| `--effect <tool=effect>` | Sets a tool's effect, over its annotations; repeatable | The server's annotations |

## See also

- [`shadowlap mcp`](./cli.md#mcp): the command's synopsis and exit statuses.
- [The Claude Agent SDK](./frameworks.md#claude-agent-sdk): MCP servers under its fence.
- [Prompt injection](./injection.md): what Shadowlap does with untrusted reads.
- [The network guard](./how-it-works.md#the-network-guard): what it watches, and what it can't.
