# MCP servers

Agents increasingly call tools through the Model Context Protocol rather than through code you wrap. `shadowlap mcp` records those calls without touching the server or the client: it is a proxy that the client starts instead of the server, and talks to over stdio as it would to the server.

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

Every message passes through unchanged except `tools/call`, which goes through the sidecar exactly like an SDK tool call:

- **Recording**: the call is forwarded to the server and its result stored under the tool's name and arguments.
- **Replay**: a call whose arguments match the recording is answered from the recording; the server never sees it.
- **After a fork**: `read` tools run live (or replay, with `--reads replay`); `write` tools are refused, and the model sees the refusal as a tool result with `isError: true`, or stubbed with `--writes stub`. The run summary counts them like any other tool.
- **A failed tool** (`replay --fail-at <call>=timeout`, `error:<message>` or a status): the server never sees the call, and the client gets a tool result with `isError: true` and the failure's message, as when a tool's handler fails. See [fail a tool](./interventions.md#fail-a-tool).

Everything else (`initialize`, `tools/list`, resources, prompts, notifications, and the server's own requests to the client) is forwarded as-is, in order. A JSON-RPC batch that carries a `tools/call` is refused under Shadowlap: each request in it gets an error (`-32600`) and the batch's notifications go on one by one, because a call inside a batch could be neither recorded nor fenced. MCP 2025-06-18 removed batching, and the official clients don't send batches.

Each recorded call names its server in `meta.mcp`: the transport (`stdio` or `http`), and the server's host (`--url`) or command (`npx @modelcontextprotocol/server-filesystem`, never the arguments after the package, nor a URL's path, since either can hold a key). The first call to a server in a run, and any call after its tool list changed, also lists the server's tools with their effects, which is what the dashboard's MCP table counts.

## A remote server: `--url`

```sh
shadowlap mcp --url https://mcp.example.com/mcp [--header 'Authorization: Bearer $TOKEN']...
```

The proxy speaks the [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) to the server: each message from the client is a POST, and each answer comes back as JSON or as an event stream, which may carry the server's own messages (progress, logs, requests to the client) before it. The proxy keeps the session the server gives at `initialize` (`Mcp-Session-Id`) and sends it, with the protocol version agreed, on every later request. Once the session starts it opens the server's stream for messages outside any request, when the server offers one, and it ends the session when the client goes away.

A tool call the recording answers, and a write after a fork, never reach the server: **a remote write never runs again on replay**. That is the difference from listing the server's host under `http` in the config, which records it as one tool with one effect.

- `--header "Name: value"` is sent with every request (repeatable). `$NAME` or `${NAME}` in a value is read from the proxy's environment, so a token can live in the client config's `env` block rather than in its arguments; `$$` is a `$` itself. Headers are never recorded.
- Some clients fill in `${…}` in their config themselves, from their own environment, before they start the proxy: Claude Code does in `.mcp.json`, and refuses a config whose variable isn't set there. Write `$NAME` in the argument, which such a client leaves alone, and give the value in the entry's `env` (in `.mcp.json`, `"env": { "ISSUES_TOKEN": "${ISSUES_TOKEN}" }`, which Claude Code fills in; in Cursor's and VS Code's, `"${env:ISSUES_TOKEN}"`): it then reaches the proxy in its environment, never on its command line. In a terminal, quote the header with `'…'` for the same reason. The dashboard's Settings → Tools copies each remote server's headers this way.
- With headers, the URL must be `https` unless the server is on this machine (`localhost`, `127.0.0.0/8`, `::1`): they would cross the network in the clear. `--allow-http` accepts plain http to another host, for a server on a network you trust.
- If the server ends the session (it answers 404), the proxy does what the transport asks of a client: it starts a new session with the client's own `initialize` and sends the request again in it, so the client never notices. A client that initializes again itself starts a new session too: an `initialize` never carries the old session's id.
- If the server can't be reached, or answers a request with an HTTP error, the client gets an error naming it. A tool call that fails this way is recorded with that error, so a replay serves the same failure without asking the server.
- A server that signs in with OAuth needs a token: pass one as a header, or put the proxy in front of a stdio bridge that does the sign-in, such as `shadowlap mcp -- npx -y mcp-remote https://mcp.example.com/sse`.
- When the client passes its environment on, the [network guard](./how-it-works.md#the-network-guard) is loaded into the proxy as into any Node process. The proxy tells it its server's address, since it records that traffic itself; only the `shadowlap mcp` process gets that hook, so an agent's own code can't use it to lift the guard.

## Effects

MCP tools declare [annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations). `readOnlyHint: true` makes a tool `read`; any other tool is `write`, because an unknown side effect must not be repeated by a replay. Override per tool when the server is under-annotated, on the command line or in `shadowlap.config.json`:

```sh
shadowlap mcp --effect search=read --effect get_page=read -- npx my-server
shadowlap mcp --url https://mcp.example.com/mcp --effect search_issues=read
```

```json
{ "mcp": { "effects": { "search": "read", "get_page": "read" } } }
```

The tool's input schema is recorded as its implementation hash, so a server whose tool schema changed between recording and replay produces the same warning as a changed SDK tool.

## Finding the run

Every command that starts an agent (`run`, `replay`, `replay --repeat`, `test`, `blame`, `verify`, `calibrate`) sets `SHADOWLAP_URL` and `SHADOWLAP_RUN_ID` for it, and the proxy uses them when the client passes its environment on (a test runner's host sets `SHADOWLAP_URL` alone, naming the run's slot, and the proxy records into that run, as the SDKs do). But MCP clients usually start servers with a minimal environment: the official SDKs pass on only `PATH`, `HOME` and a few more. So each of those commands also writes a small file for every agent it starts, `~/.shadowlap/agents/<the agent's process id>.json`, naming its sidecar and run, and removes it when the agent exits. The proxy walks up its own process tree and takes the nearest agent's. Attempts running at once never mix: each agent has its own process id. On Windows, where reading the process tree takes PowerShell, the proxy first looks for the file of the process that started it, which is the agent when the agent's own MCP client starts the proxy, and reads the tree only when that one has none.

The file carries the sidecar's session token, so the folder is owner-only, and the proxy trusts a file only when it is the user's own, owner-only and not a link, names the process it is filed under, and names that process's parent, the Shadowlap command, correctly (or, found without the tree, names a Shadowlap command still running); a file left behind by a run that was killed is ignored. When the home folder can't be written, the file goes in the project's `.shadowlap/agents` instead, and the proxy looks there and in every folder above its working directory. A file in the home folder that fails the checks makes the proxy fail closed (below); one in a project's folder, which a cloned repository could carry, is ignored.

**It fails closed.** When the proxy was started under a Shadowlap command but can't record (no run is registered where it can see, or the sidecar doesn't answer), it refuses write tools, with a tool error the model sees, and passes read tools through unrecorded, saying so on stderr: this may be a replay, and a write must not run again. Where the process tree can't be read, the proxy falls back to `.shadowlap/active.json`, which `shadowlap run` and `replay` leave in the working directory while they run.

Outside Shadowlap, the proxy says so once on stderr and becomes transparent, so the same client configuration works with and without Shadowlap.

## What is not recorded

The server's own work. A server that fetches URLs or calls APIs does that in its own process, or on its own host; the recording holds what the *tool returned*, which is what the model saw, and that is what a replay serves. The network guard is inherited by a local server's process, so connections it makes during a replay show up in the run summary.

The session itself isn't recorded either. On replay the proxy still starts the local server, or opens a session with the remote one, and forwards `initialize` and `tools/list` to it. Those only read, but the server has to be there: a replay in CI needs the local server's command to run, or the remote server to be reachable with its headers.
