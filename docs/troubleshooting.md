# Why did my replay diverge?

Start from the report. It names the call, the type of divergence, the closest recorded counterpart and the exact paths that differ:

```
✗ Diverged at call 7 (api POST /v1/messages): 6 calls replayed before divergence
  compared with run 01J8Z…, call 7
  ~ $.system[0].text
      - "…Today is 2026-09-15. You are a research agent…"
      + "…Today is 2026-09-16. You are a research agent…"
  hint: this looks like a date; to ignore it in matching, add a normalizer
        shadowlap normalize add --kind api --path '$.system[0].text' --pattern iso-date
```

`shadowlap show <replay-run>` prints it again; `shadowlap ui <replay-run>` opens at the divergence with `d` for the diff.

## By divergence type

### `request_changed`

A recorded call of the same kind and name exists, and the request differs. The diff tells you where.

| The diff shows | Cause | Fix |
|---|---|---|
| A UUID, ULID, temp path or other generated value inside a string | Ambient drift: `uuid()` or a random name in the agent's own code | Run `shadowlap calibrate --write`, add the suggested normalizer, or read the value through `uuid()` from the SDK so it is recorded |
| A date or time | Dates within a day of each run's start already match, so this one is further away, or `"clock": "exact"` is set | A real change forks on purpose. A fixed date recorded within a day of it: see [Dates and times](./normalizers-and-redaction.md#dates-and-times) |
| A whole different `system` or `tools` | A deliberate prompt or tool-definition change | Expected: system-prompt edits fork at call 1. `--prompt-from <call>` applies the change from a later model call; see [interventions](./interventions.md#apply-a-changed-prompt-from-a-later-call) |
| An added block on the last user message (`+ $.messages[n].content[k]`), or an added user message after tool output (`+ $.messages[n]`) | The agent added a turn it didn't add before, or you used `--inject` (it goes into the user turn by default) | Expected for `--inject`: the report names it (`changed by --inject 15`); otherwise a code change in the loop |
| A changed `tool_result` content | A tool returned something different: it ran live (after an earlier divergence), or `--override` | Read the timeline above the divergence; the first live call is the real cause |
| Only `cache_control` moved | Nothing: it's excluded | It won't diverge on that; look at the rest of the diff |
| A model name, `max_tokens`, `temperature` | Code or config change | Expected; or use `--set` / `--model` to try it from a later call |
| Different `tool_use` ids in history | A model response ran live earlier in this replay | Same as above: find the first live call |

### `new_call`

No unconsumed recorded call of that kind and name remains. Either the agent called a tool it didn't call before, or it called one more time than recorded, or arrival order consumed the recorded calls in a different way. Check the calls just before it in `shadowlap show`.

### `forced`

You passed `--live-tool` or `--diverge-at`. Expected.

### `beyond_recording`

The agent made more calls than the recording contains. Usually the loop's stop condition changed, or a recorded final turn now yields a tool call because something earlier ran live.

### Not reached

At the end, the report lists recorded calls the replay never made. Harmless after a fork; before one, it means the agent stopped earlier than recorded.

## Symptoms that aren't divergences

**"Replay clean" but the tool behaves as before, even though I fixed it.** A fixed tool's call key is unchanged (same arguments), so the recorded result is served. Pass `--live-tool <name>`; the report warns when a tool's source hash changed since the recording.

**A tool executed during replay even though nothing diverged.** It isn't wrapped: only calls through the SDK (`tool()`, an adapter) are recorded. Direct database clients, unwrapped HTTP calls and file writes are invisible to replay and will run. The run summary lists the hosts such calls reached (`… bypassed Shadowlap …`); wrap them with a `write` effect, or replay with `--guard block` to refuse them outright. File writes don't go over the network and aren't caught; wrap those too.

**A write ran after the fork.** `--writes allow` was set, or the tool isn't wrapped (above).

**`ShadowlapWriteBlocked` crashed my agent.** The agent doesn't catch tool errors. Catch them and return an error result to the model, as production agents should; the run then completes and the timeline shows the blocked call. Or replay with `--writes stub` and an `onFork` value.

**Replay diverges at call 1 with everything identical except one field.** Compare with the normalizer list (`shadowlap normalize ls`): a rule may be scoped to the wrong `kind`, `name` or path. Rules scoped to a tool name apply to that tool only.

**It diverges on the second run of the same test but not the first.** Something depends on state left by the first run (a file, a counter, a database row) that reaches a request. Read the diff for the value.

**Parallel tool calls come back in a different order.** That's fine: matching never uses arrival order. If you see a divergence in that region, it's the arguments, not the order.

**I replayed a run recorded on another machine and it diverges.** Paths in prompts, hostnames in tool arguments, locale-formatted dates. Normalize them, or read them through the SDK.

## Getting help

For a CLI error, `SHADOWLAP_DEBUG=1` prints the stack trace with the message.

Open a [divergence issue](https://github.com/devjoinedthechat/shadowlap/issues/new?template=divergence.md) with the report. Redact prompts and tool I/O first; the report alone is usually enough.
