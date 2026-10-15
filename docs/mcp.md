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
      "args": ["mcp", "--url", "https://mcp.example.com/mcp", "--header", "Authorization: Bearer ${ISSUES_TOKEN}"],
      "env": { "ISSUES_TOKEN": "…" }
    }
  }
}
```

Every message passes through unchanged except `tools/call`, which goes through the sidecar exactly like an SDK tool call:

- **Recording**: the call is forwarded to the server and its result stored under the tool's name and arguments.
- **Replay**: a call whose arguments match the recording is answered from the recording; the server never sees it.
- **After a fork**: `read` tools run live (or replay, with `--reads replay`); `write` tools are refused, and the model sees the refusal as a tool result with `isError: true`, or stubbed with `--writes stub`. The run summary counts them like any other tool.

Everything else (`initialize`, `tools/list`, resources, prompts, notifications, and the server's own requests to the client) is forwarded as-is, in order.

## A remote server: `--url`

```sh
shadowlap mcp --url https://mcp.example.com/mcp [--header "Authorization: Bearer ${TOKEN}"]...
```

The proxy speaks the [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) to the server: each message from the client is a POST, and each answer comes back as JSON or as an event stream, which may carry the server's own messages (progress, logs, requests to the client) before it. The proxy keeps the session the server gives at `initialize` (`Mcp-Session-Id`) and sends it, with the protocol version agreed, on every later request. Once the session starts it opens the server's stream for messages outside any request, when the server offers one, and it ends the session when the client goes away.

A tool call the recording answers, and a write after a fork, never reach the server: **a remote write never runs again on replay**. That is the difference from listing the server's host under `http` in the config, which records it as one tool with one effect.

- `--header "Name: value"` is sent with every request (repeatable). `${NAME}` in a value is read from the proxy's environment, so a token can live in the client config's `env` block rather than in its arguments. Headers are never recorded.
- With headers, the URL must be `https` unless the server is on this machine: they would cross the network in the clear.
- If the server ends the session, the client gets an error saying so and starts a new one by initializing again. If the server can't be reached, each request gets an error naming it.
- A server that signs in with OAuth needs a token: pass one as a header, or put the proxy in front of a stdio bridge that does the sign-in, such as `shadowlap mcp -- npx -y mcp-remote https://mcp.example.com/sse`.
- Under `shadowlap run`, the [network guard](./how-it-works.md#the-network-guard) is loaded into the proxy as into any Node process. The proxy tells it its server's address, since it records that traffic itself.

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

## Finding the sidecar

`shadowlap run` sets `SHADOWLAP_URL` and `SHADOWLAP_RUN_ID`, and the proxy uses them when the client passes its environment on. Many MCP clients start servers with a minimal environment, so `shadowlap run` also leaves `.shadowlap/active.json` in the working directory while a run is active, and the proxy falls back to it. Run the agent from the directory its MCP config lives in, or set the two variables explicitly in the server's `env` block.

Without either, the proxy says so once on stderr and becomes transparent, so the same client configuration works with and without Shadowlap.

## What is not recorded

The server's own work. A server that fetches URLs or calls APIs does that in its own process, or on its own host; the recording holds what the *tool returned*, which is what the model saw, and that is what a replay serves. The network guard is inherited by a local server's process, so connections it makes during a replay show up in the run summary.

The session itself isn't recorded either. On replay the proxy still starts the local server, or opens a session with the remote one, and forwards `initialize` and `tools/list` to it. Those only read, but the server has to be there: a replay in CI needs the local server's command to run, or the remote server to be reachable with its headers.
