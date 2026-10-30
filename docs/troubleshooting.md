# Why did my replay diverge?

This page explains each type of divergence a replay reports, and the symptoms that look like one, with the cause and the fix for each. Start from the report. It names the call, the type of divergence, the closest recorded counterpart and the exact paths that differ:

```text
✗ Diverged at call 1 (api POST /v1/messages): 0 calls replayed before divergence
  compared with run 01M4ZHJR8K…, call 1
  ~ $.metadata.user_id
      - "ca35b35e-b35d-4874-b430-d905bb4d9402"
      + "599d00cd-757e-4daf-9e49-ad91069b7a1a"
  hint: this looks like a UUID; to ignore it in matching, add a normalizer
        shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'
```

Here the agent puts a different UUID in every request's metadata, so its first request never matches. Today's date in a prompt doesn't do this: [dates near a run's start](./normalizers-and-redaction.md#dates-and-times) already match.

To read the report again, or step through it:

```sh
shadowlap show <replay-run>
shadowlap ui <replay-run>
```

`show` prints the report again. `ui` opens the terminal UI at the divergence: press `d` for the diff.

## By divergence type

The report names one of these types. Each section says what it means and where to look.

### `request_changed`

A recorded call of the same kind and name exists, and the request differs. The diff tells you where. This table lists what the diff can show, the cause, and the fix:

| The diff shows | Cause | Fix |
|---|---|---|
| A UUID, ULID, temp path or other generated value inside a string | Ambient drift: `uuid()` or a random name in the agent's own code | Run `shadowlap calibrate --write`, add the suggested normalizer, or read the value through the SDK's `uuid()` so it is recorded |
| A date or time | Dates within a day of either run's start already match, so this one is further from both, or `"clock": "exact"` is set | A real change forks on purpose. For a fixed date recorded within a day of it, see [Dates and times](./normalizers-and-redaction.md#dates-and-times) |
| A whole different `system` or `tools` | A deliberate prompt or tool-definition change | Expected: system-prompt edits fork at call 1. `--prompt-from <call>` applies the change from a later model call ([interventions](./interventions.md#apply-a-changed-prompt-from-a-later-call)) |
| An added block on the last user message (`+ $.messages[n].content[k]`), or an added user message after tool output (`+ $.messages[n]`) | The agent added a turn it didn't add before, or you used `--inject`, which goes into the user turn by default | Expected for `--inject`: the report names it (`changed by --inject 15`). Otherwise, a code change in the loop |
| A changed `tool_result` content | A tool returned something different: it ran live after an earlier divergence, or `--override` changed it | Read the timeline above the divergence: the first live call is the real cause |
| Only `cache_control` moved | Nothing: it's excluded | It won't diverge on that. Look at the rest of the diff |
| Claude Code's `metadata.user_id` (`{"device_id":…,"session_id":…}`) | Nothing: Claude Code names a different session in every run, and matching masks it | It won't diverge on that. Look at the rest of the diff |
| A model name, `max_tokens`, `temperature` | A code or config change | Expected. Or use `--set` or `--model` to try it from a later call |
| `headers.anthropic-beta` (or `anthropic-version`, `openai-beta`) | Another beta flag or API version than at recording: an SDK upgrade, or a flag turned on in code | Expected. Send the recorded value, or record again (see below the table) |
| Different `tool_use` ids in history | A model response ran live earlier in this replay | Find the first live call, as for a changed `tool_result` |

**API version and beta headers.** These headers change what the model does, so they are part of the call key, and no normalizer masks them. A recording that names no API version, such as one imported from a trace, matches any.

### `new_call`

No unconsumed recorded call of that kind and name remains. One of these happened:

- the agent called a tool it didn't call before;
- it called one more time than recorded;
- arrival order consumed the recorded calls in a different way.

Check the calls just before it in `shadowlap show`.

### `forced`

You passed `--live-tool` or `--diverge-at`. Expected.

### `beyond_recording`

The agent made more calls than the recording contains. Usually the loop's stop condition changed, or a recorded final turn yields a tool call this time because something earlier ran live.

### `ended_early`

Every request the agent sent matched, but it stopped before making every recorded model or tool call. The report reads `✗ Ended early at call N: X of Y recorded calls replayed`, where N is the first recorded call it never made. Two kinds of read don't count:

- clock, random and pure reads left over;
- a clock, random or pure read the agent made that the recording never held: it is answered live as an extra read.

It is kept on the run like any other divergence:

- `--strict` exits 1;
- `shadowlap test`, `bisect` and the test plugins fail it;
- `ls` and the dashboard list it as `ended early @N`, never as a clean replay.

**Fix:** read the agent's output for why it stopped: an exception it caught, a stop condition that changed, or a step it skips this time.

### Not reached

At the end, the report lists recorded calls the replay never made. That is harmless after a fork. Without a fork, a model or tool call among them makes the replay [`ended_early`](#ended_early).

## Symptoms that aren't divergences

These go wrong without a divergence in the report. Where a symptom links, its section below has the details.

| Symptom | Cause | Fix |
|---|---|---|
| "Replay clean", but a tool you fixed behaves as before | Its call key is unchanged (same arguments), so the recorded result is served | Pass `--live-tool <name>`. The report warns when a tool's source hash changed since the recording |
| [A tool ran during a replay, though nothing diverged](#a-tool-ran-during-a-replay) | It isn't wrapped: only calls through the SDK (`tool()`, an adapter) are recorded | Wrap it with a `write` effect, or replay with `--guard block` |
| [A database write ran under `--guard block`, and no host is listed for it](#a-database-write-ran-under---guard-block) | The client connects from C, out of the network guard's sight | Wrap the calls as `write` tools, or point the client at a local instance |
| [The summary says no Shadowlap preload loaded](#no-shadowlap-preload-loaded) | The network guard watched none of the agent's connections | Remove what kept the preload out. On another runtime, wrap tools and use `--guard warn` |
| A write ran after the fork | `--writes allow` was set, or the tool isn't wrapped | Leave out `--writes allow`, or wrap the tool |
| [`ShadowlapWriteBlocked` crashed the agent](#shadowlapwriteblocked-crashed-the-agent) | The agent doesn't catch tool errors | Catch them, or replay with `--writes stub` and an `onFork` value |
| A replay diverges at call 1, everything identical but one field | A normalizer may be scoped to the wrong `kind`, `name` or path | Compare with `shadowlap normalize ls`. Rules scoped to a tool name apply to that tool only |
| A test diverges on its second run but not its first | State the first run left (a file, a counter, a database row) reaches a request | Read the diff for the value |
| Parallel tool calls come back in a different order | Nothing: matching never uses arrival order | A divergence in that region is in the arguments, not the order |
| [A Node agent behind a proxy can't open a Realtime WebSocket, or records no model calls](#a-node-agent-behind-a-proxy) | undici's `ProxyAgent` sends the sidecar's loopback traffic to the proxy | Use `EnvHttpProxyAgent` |
| [A Node agent never starts: `--import= is not allowed in NODE_OPTIONS`](#a-node-agent-never-starts) | The agent's Node is older than 18.18 | Run the agent on Node 18.18 or later |
| A run recorded on another machine diverges | Paths in prompts, hostnames in tool arguments, locale-formatted dates | Normalize them, or read them through the SDK |

### A tool ran during a replay

The tool isn't wrapped: only calls through the SDK (`tool()`, an adapter) are recorded. What happens to an unwrapped tool depends on who calls it:

- **A tool the model called** that writes, or may, is refused before a replay starts, and one that reads is named at its end ([tools Shadowlap did not record](./how-it-works.md#tools-shadowlap-did-not-record)).
- **Calls the agent's own code makes**, such as direct database clients, unwrapped HTTP calls and file writes, are invisible to replay and will run.

The run summary lists the hosts such calls reached (`… bypassed Shadowlap …`). Wrap them with a `write` effect, or replay with `--guard block` to refuse them outright. File writes don't go over the network and aren't caught, so wrap those too.

### A database write ran under `--guard block`

The summary lists no host for it, because the client opens its connection in C, out of the network guard's sight. These clients do:

- libpq under `psycopg` and `psycopg2`;
- `mysqlclient`, `grpcio` and `confluent-kafka`;
- Node's native addons, such as `pg-native`.

Wrap the calls as tools with a `write` effect, so a replay serves them from the recording and fences them after a fork. Or point the client at a local instance while you replay. Clients written in the language itself (`asyncpg`, `pymongo`, `redis`, `pg`, `mysql2`) connect through it and are guarded. See [what the guard can't see](./how-it-works.md#what-it-cant-see).

### No Shadowlap preload loaded

The run made model or tool calls, but no Node or Python process of the agent said its preload loaded. So the network guard watched none of its connections, and under `--guard block` the run failed for it.

The summary line names the cause when the command shows one:

| In the command | Why the preload is missing |
|---|---|
| Bun or Deno | They load no Node preload |
| Python with `-I`, `-E` or `-S` | These skip `PYTHONPATH` or `site` |
| `env -i`, `sudo` or a container | They start the agent without Shadowlap's environment |
| `opentelemetry-instrument` | Its own `sitecustomize` comes first |

Otherwise, check two things:

- nothing between `shadowlap` and the agent sets `NODE_OPTIONS` or `PYTHONPATH` anew;
- a Node agent runs on Node 18.18 or later.

An agent on another runtime (Go, Rust, Java, Bun, Deno) gets no guard. Wrap what it does to the world as tools, and test it with `--guard warn`, which accepts a run the guard can't watch. `shadowlap doctor` explains the newest such run.

### `ShadowlapWriteBlocked` crashed the agent

The agent doesn't catch tool errors. Catch them and return an error result to the model, as production agents should: the run then completes, and the timeline shows the blocked call. Or replay with `--writes stub` and an `onFork` value.

### A Node agent behind a proxy

The agent can't open a Realtime WebSocket, or, with `SHADOWLAP_CAPTURE=off`, records no model calls.

Node's own `WebSocket`, and with capture off its `fetch` too, go through the dispatcher the agent set itself. undici's `ProxyAgent` sends every request to the proxy, the sidecar's loopback address included, where the proxy can't reach it.

Use `EnvHttpProxyAgent` instead. It takes the proxy from `HTTP_PROXY` and `HTTPS_PROXY` (or its options), and honours the `NO_PROXY` that `shadowlap run` sets. With capture on, `fetch` reaches the sidecar on a connection of its own, and tools, the clock and recorded input never go through the dispatcher.

### A Node agent never starts

The agent fails with `node: --import= is not allowed in NODE_OPTIONS`, and the CLI says the agent's Node is too old for Shadowlap's guard. Shadowlap loads its guard and in-process capture into a Node agent through `--import` in `NODE_OPTIONS`, which Node takes from 18.18 on.

Run the agent on Node 18.18 or later. Two things can pick an older Node than the one `shadowlap` runs on:

- **A version manager** can give the project an older Node: `node --version` in the agent's folder says which it gets.
- **A launcher or a script** can pick yet another, such as `npx node@18.17.0` or `volta run`. `run` and `replay` can't ask it, so they keep the empty run, and its summary says that if Node printed this line, the agent's Node is too old.

## Getting help

For a CLI error, `SHADOWLAP_DEBUG=1` prints the stack trace with the message.

Open a [divergence issue](https://github.com/devjoinedthechat/shadowlap/issues/new?template=divergence.md) with the report. Redact prompts and tool I/O first: the report alone is usually enough.

## See also

- [How it works](./how-it-works.md): fingerprints, matching, effects and the guard.
- [Normalizers and redaction](./normalizers-and-redaction.md): masking values that change on every run.
- [Interventions](./interventions.md): forking on purpose at a call.
