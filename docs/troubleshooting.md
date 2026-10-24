# Why did my replay diverge?

Start from the report. It names the call, the type of divergence, the closest recorded counterpart and the exact paths that differ:

```
✗ Diverged at call 1 (api POST /v1/messages): 0 calls replayed before divergence
  compared with run 01M4ZHJR8K…, call 1
  ~ $.metadata.user_id
      - "ca35b35e-b35d-4874-b430-d905bb4d9402"
      + "599d00cd-757e-4daf-9e49-ad91069b7a1a"
  hint: this looks like a UUID; to ignore it in matching, add a normalizer
        shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'
```

Here the agent puts a new UUID in every request's metadata, so its first request never matches. Today's date in a prompt doesn't do this: [dates near a run's start](./normalizers-and-redaction.md#dates-and-times) already match.

`shadowlap show <replay-run>` prints it again; `shadowlap ui <replay-run>` opens at the divergence with `d` for the diff.

## By divergence type

### `request_changed`

A recorded call of the same kind and name exists, and the request differs. The diff tells you where.

| The diff shows | Cause | Fix |
|---|---|---|
| A UUID, ULID, temp path or other generated value inside a string | Ambient drift: `uuid()` or a random name in the agent's own code | Run `shadowlap calibrate --write`, add the suggested normalizer, or read the value through `uuid()` from the SDK so it is recorded |
| A date or time | Dates within a day of either run's start already match, so this one is further from both, or `"clock": "exact"` is set | A real change forks on purpose. A fixed date recorded within a day of it: see [Dates and times](./normalizers-and-redaction.md#dates-and-times) |
| A whole different `system` or `tools` | A deliberate prompt or tool-definition change | Expected: system-prompt edits fork at call 1. `--prompt-from <call>` applies the change from a later model call; see [interventions](./interventions.md#apply-a-changed-prompt-from-a-later-call) |
| An added block on the last user message (`+ $.messages[n].content[k]`), or an added user message after tool output (`+ $.messages[n]`) | The agent added a turn it didn't add before, or you used `--inject` (it goes into the user turn by default) | Expected for `--inject`: the report names it (`changed by --inject 15`); otherwise a code change in the loop |
| A changed `tool_result` content | A tool returned something different: it ran live (after an earlier divergence), or `--override` | Read the timeline above the divergence; the first live call is the real cause |
| Only `cache_control` moved | Nothing: it's excluded | It won't diverge on that; look at the rest of the diff |
| Claude Code's `metadata.user_id` (`{"device_id":…,"session_id":…}`) | Nothing: Claude Code names a new session in every run, and matching masks it | It won't diverge on that; look at the rest of the diff |
| A model name, `max_tokens`, `temperature` | Code or config change | Expected; or use `--set` / `--model` to try it from a later call |
| `headers.anthropic-beta` (or `anthropic-version`, `openai-beta`) | The client sends another beta flag or API version than it recorded with: an SDK upgrade, or a flag turned on in code | Expected: these headers change what the model does, so they are part of the call key and no normalizer masks them. Send the recorded value, or record again. A recording that names no API version, such as one imported from a trace, matches any |
| Different `tool_use` ids in history | A model response ran live earlier in this replay | Same as above: find the first live call |

### `new_call`

No unconsumed recorded call of that kind and name remains. Either the agent called a tool it didn't call before, or it called one more time than recorded, or arrival order consumed the recorded calls in a different way. Check the calls just before it in `shadowlap show`.

### `forced`

You passed `--live-tool` or `--diverge-at`. Expected.

### `beyond_recording`

The agent made more calls than the recording contains. Usually the loop's stop condition changed, or a recorded final turn now yields a tool call because something earlier ran live.

### `ended_early`

Every request the agent sent matched, but it stopped before making every recorded model or tool call: `✗ Ended early at call N: X of Y recorded calls replayed`, where N is the first recorded call it never made. Clock, random and pure reads left over don't count, nor does one the agent made that the recording never held: it is answered live as an extra read. It is kept on the run like any other divergence, so `--strict` exits 1, `shadowlap test`, `bisect` and the test plugins fail it, and `ls` and the dashboard list it as `ended early @N`, never as a clean replay. Read the agent's output for why it stopped: an exception it caught, a stop condition that changed, a step it now skips.

### Not reached

At the end, the report lists recorded calls the replay never made. Harmless after a fork. Without one, a model or tool call among them makes the replay [`ended_early`](#ended_early).

## Symptoms that aren't divergences

**"Replay clean" but the tool behaves as before, even though I fixed it.** A fixed tool's call key is unchanged (same arguments), so the recorded result is served. Pass `--live-tool <name>`; the report warns when a tool's source hash changed since the recording.

**A tool executed during replay even though nothing diverged.** It isn't wrapped: only calls through the SDK (`tool()`, an adapter) are recorded. Direct database clients, unwrapped HTTP calls and file writes are invisible to replay and will run. The run summary lists the hosts such calls reached (`… bypassed Shadowlap …`); wrap them with a `write` effect, or replay with `--guard block` to refuse them outright. File writes don't go over the network and aren't caught; wrap those too.

**A database write ran during a replay under `--guard block`, and the summary lists no host for it.** The client opens its connection in C, out of the network guard's sight: libpq under `psycopg` and `psycopg2`, `mysqlclient`, `grpcio`, `confluent-kafka`, and Node's native addons such as `pg-native`. Wrap the calls as tools with a `write` effect, so a replay serves them from the recording and fences them after a fork, or point the client at a local instance while you replay. Clients written in the language itself (`asyncpg`, `pymongo`, `redis`, `pg`, `mysql2`) connect through it and are guarded. See [what the guard can't see](./how-it-works.md#what-it-cant-see).

**The summary says no Shadowlap preload loaded in the agent's processes.** The run made model or tool calls, but no Node or Python process of the agent said its preload loaded, so the network guard watched none of its connections, and under `--guard block` the run failed for it. The line names the cause when the command shows one: Bun or Deno, which load no Node preload; Python with `-I`, `-E` or `-S`, which skip `PYTHONPATH` or `site`; `env -i`, `sudo` or a container, which start the agent without Shadowlap's environment; or `opentelemetry-instrument`, whose own `sitecustomize` comes first. Otherwise check that nothing between `shadowlap` and the agent sets `NODE_OPTIONS` or `PYTHONPATH` anew, and that a Node agent runs on Node 18.18 or later. An agent on another runtime (Go, Rust, Java, Bun, Deno) gets no guard: wrap what it does to the world as tools, and test it with `--guard warn`, which accepts a run the guard can't watch. `shadowlap doctor` explains the newest such run.

**A write ran after the fork.** `--writes allow` was set, or the tool isn't wrapped (above).

**`ShadowlapWriteBlocked` crashed my agent.** The agent doesn't catch tool errors. Catch them and return an error result to the model, as production agents should; the run then completes and the timeline shows the blocked call. Or replay with `--writes stub` and an `onFork` value.

**Replay diverges at call 1 with everything identical except one field.** Compare with the normalizer list (`shadowlap normalize ls`): a rule may be scoped to the wrong `kind`, `name` or path. Rules scoped to a tool name apply to that tool only.

**It diverges on the second run of the same test but not the first.** Something depends on state left by the first run (a file, a counter, a database row) that reaches a request. Read the diff for the value.

**Parallel tool calls come back in a different order.** That's fine: matching never uses arrival order. If you see a divergence in that region, it's the arguments, not the order.

**A Node agent behind a proxy can't open a Realtime WebSocket, or, with `SHADOWLAP_CAPTURE=off`, records no model calls.** Node's own `WebSocket`, and with capture off its `fetch` too, go through the dispatcher the agent set itself, undici's `ProxyAgent`, which sends every request to the proxy, the sidecar's loopback address too, where the proxy can't reach it. Use `EnvHttpProxyAgent` instead: it takes the proxy from `HTTP_PROXY` and `HTTPS_PROXY` (or its options) and honours the `NO_PROXY` that `shadowlap run` sets. With capture on, `fetch` reaches the sidecar on a connection of its own, and tools, the clock and recorded input never go through the dispatcher.

**A Node agent never starts: `node: --import= is not allowed in NODE_OPTIONS`, and the CLI says the agent's Node is too old for Shadowlap's guard.** Shadowlap loads its guard and in-process capture into a Node agent through `--import` in `NODE_OPTIONS`, which Node takes from 18.18 on. Run the agent on Node 18.18 or later. A version manager can give the project an older Node than the one `shadowlap` runs on: `node --version` in the agent's folder says which it gets. A launcher or a script can pick yet another, such as `npx node@18.17.0` or `volta run`, which `run` and `replay` can't ask: they keep the empty run, and its summary says that if Node printed this line, the agent's Node is too old.

**I replayed a run recorded on another machine and it diverges.** Paths in prompts, hostnames in tool arguments, locale-formatted dates. Normalize them, or read them through the SDK.

## Getting help

For a CLI error, `SHADOWLAP_DEBUG=1` prints the stack trace with the message.

Open a [divergence issue](https://github.com/devjoinedthechat/shadowlap/issues/new?template=divergence.md) with the report. Redact prompts and tool I/O first; the report alone is usually enough.
