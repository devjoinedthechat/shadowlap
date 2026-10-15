# Normalizers and redaction

Both are rewrite rules with the same shape: an optional scope (`kind`, `name`), an optional JSONPath, a pattern, and a replacement. **Normalizers** mask values before fingerprinting and never touch what is stored. **Redaction rules** mask stored content when a run is exported, and are then applied as normalizers when that export is replayed, so a redacted recording still matches.

Rules live in `shadowlap.config.json` in the working directory, and the commands below edit it one change at a time (see [Editing the file](#editing-the-file)):

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
shadowlap normalize add --pattern '/req_[a-z0-9]+/' --replace '<REQ>'
shadowlap normalize add --kind tool --name create_ticket --path '$.args.idempotency_key' --replace '<ID>'
shadowlap normalize ls
shadowlap normalize rm 2
```

A rule is a pattern, a path, or both:

| Rule | Masks |
|---|---|
| `--pattern` alone | what the pattern matches, in every string of the request |
| `--path` and `--pattern` | what the pattern matches, in the value at the path |
| `--path` alone | the whole value at the path, whatever it is |

- `--path` is a JSONPath subset: `$.a.b[0].c`, `[*]` and `.*` wildcards, `["quoted key"]`. For tool calls the arguments are under `$.args`.
- `--pattern` is a named pattern (`iso-date`, `iso-datetime`, `uuid`, `ulid`, `number`, `email`) or a `/regex/flags` literal.
- Scope with `--kind` (`api`, `tool`, `clock`, `random`) and `--name` (a tool name, or `POST /v1/messages`).
- `--replace` is what a match becomes; `<MASKED>` when it is left out.

`add` refuses, with the reason: a rule with neither a path nor a pattern, which would change nothing; a pattern that can match no text at all, such as `/x*/`, `/\b/` or `/(?=sk-)/`, which would insert the replacement instead of masking anything; `--path '$'` with no pattern unless `--name` scopes it to one tool or call, which would make every call look the same; and a pattern or path it can't read. Adding a rule that is already there changes nothing.

`ls` numbers the rules, and `rm` takes that number (`2` or `#2`), or the tool name, path or pattern of exactly one rule: `shadowlap normalize rm create_ticket`. The rules after a removed one move up a number. `ls --json` prints the file, its version and every rule with its number; a rule the config can no longer load is listed with the reason, so `rm` can take it out.

A rule that can't be loaded (a misspelled pattern, a path that isn't one) stops only what applies it, with its number and the reason: a broken normalizer stops `run`, `replay`, `calibrate` and `test`; a broken redaction rule stops `pack`, the exports and `redact preview`, never a recording. The dashboard opens either way, and a run downloaded from it as HTML is refused, not shared without the rule. The limits `add` puts on a rule's length are for what a command line or the dashboard sends; a long rule you write into the file yourself loads as it is.

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

Without a run named, it takes the newest finished recording made here (one that completed or failed, not one imported from a pack or a capture); with none, it says to record a run first. A recording that already replays clean ends with "This recording replays clean with the current rules. Nothing to add." `--write` adds the proposals to `shadowlap.config.json` and says their numbers; `--json` prints the run, how it was chosen (`source`: `given` or `newest`), every round, the proposals and the numbers `--write` gave them; a dashboard job that runs calibrate gets the same object as its result.

It makes no model calls, and writes are blocked while it runs. Run it after your first recording, and again when a replay forks for a reason you didn't cause. For a value in the middle of a longer string, the proposed pattern is anchored on the fixed text before it, so it masks only that value. When a change isn't a value in a request (the agent makes a different call, because it iterates a set or picks something at random), calibration stops and shows the divergence: read that value through the SDK's `uuid()` or `now()`, or make the choice deterministic.

**The design rule behind this:** nothing is excluded from matching implicitly, with two exceptions. `cache_control` markers are stripped, because the provider documents them as behavior-neutral and agents move them routinely. Dates and times near a run's start are masked, because by construction they mean "now" in both runs. Stripping keys by name everywhere would silently merge genuinely different requests, and a false replay hit returns the wrong response with no signal; a false divergence is visible and fixable.

## Redaction

Recordings contain everything the agent saw: prompts, tool inputs and outputs, and any user data in them. Before a pack leaves your machine, mask what shouldn't:

```sh
shadowlap redact add --pattern email
shadowlap redact add --pattern uuid --replace '<UUID>'
shadowlap redact add --kind tool --path '$.args.api_key' --replace '<KEY>'
shadowlap redact preview
shadowlap pack <run> ./share/run
```

Rules take the same forms as normalizers, scoped by `--kind api` or `--kind tool`; the replacement is `<REDACTED>` when it is left out. `redact ls` and `redact rm` work as they do for normalizers.

`pack` applies the rules to a scratch copy of the run: path-scoped rules mask request fields; pathless pattern rules mask every string of every request, the raw text of responses and tool results, and an attempt's error message. The local store is never modified. The run's command line, labels and notes are copied as they are, because a replay of the pack runs that command. The copy records its rules, and a replay of it applies them as normalizers, so it still replays clean; a rule that lists the values it hides (an alternation of customer names) travels with every copy that way. `--no-redact` skips the rules.

A path rule masks only at its path. A tool argument the model wrote also appears in the conversation sent back to the model (`$.messages[…].content[…].input`), so mask a value that can appear there with a pattern, or a path for each place it appears.

Because a replay applies the rules a second time, `redact add` refuses a replacement the pattern would rewrite again (`--pattern number --replace n0` turns into `nn0`). It also refuses a replacement that copies matched text back into the copy (`$&`, `$1`, `$<name>`, `` $` `` or `$'`); `$$` is a literal dollar sign. To keep the text around a secret, match only the secret, with a lookbehind for what comes before it: `--pattern '/(?<=key=)\w+/'`. Redaction is pattern-based: it masks what your rules describe and nothing else. A value a streamed response splits across two events is not matched, so check the preview, and review a pack before sharing it.

Credentials never need redacting: API keys and authorization headers are forwarded upstream and never stored in the first place.

### Where the rules apply

The Settings page and `REDACTION_EXPORTS` list the same thing, and a test holds each export to it:

| Export | Applies |
|---|---|
| `shadowlap pack` | every rule, on every request and response it copies and the errors with them |
| `shadowlap export html` | every rule, as `pack` applies them |
| `shadowlap export dataset` | every rule on the conversations and answers it keeps, as `pack` applies them, then rules without a path on the rest of each row (command line, labels, notes) |
| `shadowlap export otel` | a trace carries no prompt text; rules without a path apply to its span names, command line, model and tool names, and error messages |
| `shadowlap export har` | no rules yet: a HAR carries whole requests and responses, so share a run with `pack` or `export html` |

Each export that applies rules takes `--no-redact`, and stops, naming the rule, when one can't be read.

### Preview

`shadowlap redact preview [run]` shows what the rules would mask in a run, before it leaves the machine: the run's stored requests, responses and errors, retries included, go through the same functions pack applies, and nothing is written. Without a run named it takes the newest run that has ended; a run still recording is refused. A conversation sends its earlier messages again with every request; the preview reads each of them once, so it takes time in proportion to the run's length (a run of 1,200 model calls takes about a second). In the dashboard it runs as a job, so a long run never holds up the page.

```
01M2R1HDVD (node agent.js): 5 values would be masked
  #1  every call  any string  email → <REDACTED>  4
        - …The account owner is alice@example.com.
        + …The account owner is <REDACTED>.
        - Refund order 4417 for bob@example.com
        + Refund order 4417 for <REDACTED>
  #2  tool  $.args.api_key  whole value → <KEY>  1
        - sk-live-123
        + <KEY>
  #3  every call  any string  /\b(?:\d[ -]?){13,16}\b/ → <CARD>  0  no matches in this run
```

Each rule shows how many values it would mask and up to two of them before and after, cut to the change. A value that a conversation sends again with every later request counts once. A rule that masks nothing says why: no matches in the run, no call of its kind or name, no request with its path, or a path whose values don't match its pattern. `--json` prints the same object, and a dashboard job that runs the preview gets it as its result.

## Editing the file

`normalize add` and `rm`, `redact add` and `rm`, and `calibrate --write` edit `shadowlap.config.json` through one editor, with the same checks:

- One edit at a time: an edit takes `shadowlap.config.json.lock` beside the file, and waits up to two seconds for another to finish. The lock names the process holding it: a lock whose process is gone is taken over at once, any other after ten seconds untouched, and a writer only ever removes its own. The dashboard waits for the lock without holding up anything else it is doing.
- An edit replaces the file with one rename, so the file is never half written.
- Every key the edit doesn't touch keeps its place and its value, keys this version doesn't know included, and the file keeps its indentation and line endings.
- `--expect <version>` on `add` and `rm` refuses the edit when the file is no longer the version `ls --json` printed, so a script that read rule #2 never removes a rule someone added in the meantime.

Adding and removing a rule is recorded in the project's activity (`normalizer.added`, `redaction.removed`, …) with who did it, in a store that exists: editing the config never creates one.
