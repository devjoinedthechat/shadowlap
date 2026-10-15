# MCP servers

Agents increasingly call tools through the Model Context Protocol rather than through code you wrap. `shadowlap mcp` records those calls without touching the server or the client: it is a stdio proxy that the client starts instead of the server.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "shadowlap",
      "args": ["mcp", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/srv/notes"]
    }
  }
}
```

Every message passes through unchanged except `tools/call`, which goes through the sidecar exactly like an SDK tool call:

- **Recording**: the call is forwarded to the server and its result stored under the tool's name and arguments.
- **Replay**: a call whose arguments match the recording is answered from the recording; the server never sees it.
- **After a fork**: `read` tools run live (or replay, with `--reads replay`); `write` tools are refused, and the model sees the refusal as a tool result with `isError: true`, or stubbed with `--writes stub`. The run summary counts them like any other tool.
- **A failed tool** (`replay --fail-at <call>=timeout`, `error:<message>` or a status): the server never sees the call, and the client gets a tool result with `isError: true` and the failure's message, as when a tool's handler fails. See [fail a tool](./interventions.md#fail-a-tool).

Everything else (`initialize`, `tools/list`, resources, prompts, notifications) is forwarded as-is, in order.

## Effects

MCP tools declare [annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations). `readOnlyHint: true` makes a tool `read`; any other tool is `write`, because an unknown side effect must not be repeated by a replay. Override per tool when the server is under-annotated, on the command line or in `shadowlap.config.json`:

```sh
shadowlap mcp --effect search=read --effect get_page=read -- npx my-server
```

```json
{ "mcp": { "effects": { "search": "read", "get_page": "read" } } }
```

The tool's input schema is recorded as its implementation hash, so a server whose tool schema changed between recording and replay produces the same warning as a changed SDK tool.

## Finding the sidecar

`shadowlap run` sets `SHADOWLAP_URL` and `SHADOWLAP_RUN_ID`, and the proxy uses them when the client passes its environment on. Many MCP clients start servers with a minimal environment, so `shadowlap run` also leaves `.shadowlap/active.json` in the working directory while a run is active, and the proxy falls back to it. Run the agent from the directory its MCP config lives in, or set the two variables explicitly in the server's `env` block.

Without either, the proxy says so once on stderr and becomes transparent, so the same client configuration works with and without Shadowlap.

## What is not recorded

The server's own network traffic. A server that fetches URLs or calls APIs does that in its own process; the recording holds what the *tool returned*, which is what the model saw, and that is what a replay serves. The network guard is inherited by the server process, so connections it makes during a replay show up in the run summary.
