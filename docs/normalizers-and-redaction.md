# Normalizers and redaction

Both are rewrite rules with the same shape: an optional scope (`kind`, `name`), an optional JSONPath, a pattern, and a replacement. **Normalizers** mask values before fingerprinting and never touch what is stored. **Redaction rules** mask stored content when a run is exported, and are then applied as normalizers when that export is replayed, so a redacted recording still matches.

Rules live in `shadowlap.config.json` in the working directory:

```json
{
  "normalize": [
    { "kind": "api", "path": "$.system[*].text", "pattern": "iso-datetime", "replace": "<DATETIME>" },
    { "kind": "tool", "name": "create_ticket", "path": "$.args.idempotency_key", "replace": "<ID>" }
  ],
  "redact": [
    { "pattern": "email", "replace": "<EMAIL>" },
    { "kind": "tool", "path": "$.args.api_key", "pattern": "/.+/", "replace": "<KEY>" }
  ]
}
```

## Normalizers

A replay diverges when a request differs from the recording. Some differences are deliberate; some are ambient: today's date in a prompt, a request id, a UUID in tool arguments. Normalizers tell Shadowlap which parts of a request are not part of its identity.

```sh
shadowlap normalize add --kind api --path '$.system[0].text' --pattern iso-date
shadowlap normalize add --kind tool --name create_ticket --path '$.args.idempotency_key' --replace '<ID>'
shadowlap normalize ls
```

- `--path` is a JSONPath subset: `$.a.b[0].c`, `[*]` and `.*` wildcards, `["quoted key"]`. For tool calls the arguments are under `$.args`. Omit the path to apply the pattern to every string in the request.
- `--pattern` is a named pattern (`iso-date`, `iso-datetime`, `uuid`, `ulid`, `number`, `email`) or a `/regex/flags` literal. With a path and no pattern, the whole value is replaced.
- Scope with `--kind` (`api`, `tool`) and `--name` (a tool name, or `POST /v1/messages`).

Normalizers apply at match time: adding one makes older recordings match too, because the parent's fingerprints are recomputed from its stored requests under the current rules when a replay starts.

When a divergence is only a date, time, UUID or ULID, the report proposes the rule:

```
  hint: this looks like a date; to ignore it in matching, add a normalizer
        shadowlap normalize add --kind api --path '$.system[0].text' --pattern iso-date
```

The TUI's actions palette adds it with one key.

## Dates and times

An agent that writes "Today is 2026-09-16" into its prompt sends a different request tomorrow. So before matching, Shadowlap reads every date, timestamp and epoch value within about a day of the run's own start as a placeholder: `<date>`, `<datetime>` or `<epoch>`. The recording's "today" and the replay's "today" then match, however far apart the two runs are, and a golden recorded in June still replays in September.

It recognizes ISO dates and timestamps (`2026-09-16`, `2026-09-16T10:31:22Z`, with or without an offset), HTTP dates (`Wed, 16 Sep 2026 10:31:22 GMT`), JavaScript's `Date.toString()`, English dates (`September 16, 2026`, `16 Sep 2026`, with or without the weekday), and epoch seconds and milliseconds (`time.time()`, `Date.now()`), in model requests and tool arguments.

- Only values near each run's own start are masked. A date a week earlier stays as it is, so changing "since 2026-09-09" to "since 2026-09-02" still forks, and the diff shows that change without the dates that were "today".
- It affects matching only. Stored requests keep their values, and the agent's clock is never changed, so a live call after a fork carries the real time. Request signing depends on it.
- A fixed date that happens to fall within a day of when a run was recorded is masked in that recording and not in a later replay, so it forks. The report says so. Set `"clock": "exact"` in `shadowlap.config.json` to match dates exactly, and add normalizers where you need them.

## Calibrate

`shadowlap calibrate` finds everything else an agent generates anew on every run. It replays a recording offline, with the same code, which should be clean. Each divergence is something the agent made up again: a request id, a temp directory, a random seed. It proposes a normalizer for it and replays again, until the replay is clean:

```
⑂ Calibrating 01M2R1HDVD (node agent.js): replaying it offline until it is clean

  round 1  diverged at call 1 (api POST /v1/messages)
           + $.metadata.user_id: this looks like a UUID  uuid
           + $.system: a value generated on each run  /\/tmp\/agent-[A-Za-z0-9_]+/
  round 2  diverged at call 2 (tool save_report)
           + $.args.path: a value generated on each run  /\/tmp\/agent-[A-Za-z0-9_]+/
  round 3  clean: 2/2 calls replayed

✓ 3 normalizers make this recording replay clean. Add them with --write, or one by one:
    shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'
    …
```

It makes no model calls, and writes are blocked while it runs. Run it after your first recording, and again when a replay forks for a reason you didn't cause. For a value in the middle of a longer string, the proposed pattern is anchored on the fixed text before it, so it masks only that value. When a change isn't a value in a request (the agent makes a different call, because it iterates a set or picks something at random), calibration stops and shows the divergence: read that value through the SDK's `uuid()` or `now()`, or make the choice deterministic.

**The design rule behind this:** nothing is excluded from matching implicitly, with two exceptions. `cache_control` markers are stripped, because the provider documents them as behavior-neutral and agents move them routinely. Dates and times near a run's start are masked, because by construction they mean "now" in both runs. Stripping keys by name everywhere would silently merge genuinely different requests, and a false replay hit returns the wrong response with no signal; a false divergence is visible and fixable.

## Redaction

Recordings contain everything the agent saw: prompts, tool inputs and outputs, and any user data in them. Before a pack leaves your machine, mask what shouldn't:

```sh
shadowlap redact add --pattern email
shadowlap redact add --pattern uuid --replace '<UUID>'
shadowlap redact add --kind tool --path '$.args.api_key' --pattern '/.+/' --replace '<KEY>'
shadowlap pack <run> ./share/run
```

`pack` applies the rules to a scratch copy of the run: path-scoped rules mask request fields; pathless pattern rules mask every string of every request and the raw text of responses and tool results. The local store is never modified. The copy records its rules, and a replay of it applies them as normalizers, so it still replays clean. `--no-redact` skips the rules.

Two rules for rules: a replacement must not itself match the pattern (rules are applied again at match time and must be idempotent), and redaction is pattern-based: it masks what your rules describe and nothing else. Review a pack before sharing it.

Credentials never need redacting: API keys and authorization headers are forwarded upstream and never stored in the first place.
