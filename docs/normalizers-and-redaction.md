# Normalizers and redaction

Normalizers and redaction rules are rewrite rules with the same shape: an optional scope (`kind`, `name`), an optional JSONPath, a pattern, and a replacement. **Normalizers** mask values before fingerprinting and never touch what is stored. **Redaction rules** mask stored content when a run is exported, and are then applied as normalizers when that export is replayed, so a redacted recording still matches.

Rules live in `shadowlap.config.json` in the working directory, and the commands below edit it one change at a time (see [Editing the file](#editing-the-file)):

```json
{
  "normalize": [
    { "kind": "api", "path": "$.metadata.user_id", "pattern": "uuid", "replace": "<UUID>" },
    { "kind": "tool", "name": "create_ticket", "path": "$.args.idempotency_key", "replace": "<ID>" }
  ],
  "redact": [
    { "pattern": "email", "replace": "<EMAIL>" },
    { "kind": "tool", "path": "$.args.api_key", "pattern": "/.+/", "replace": "<KEY>" }
  ]
}
```

Credentials need no rule: Shadowlap masks them by itself, as [Credentials](#credentials) lists. This page covers:

- [Normalizers](#normalizers)
- [Dates and times](#dates-and-times)
- [Calibrate](#calibrate)
- [Redaction](#redaction)
- [Credentials](#credentials)
- [Editing the file](#editing-the-file)

## Normalizers

A replay diverges when a request differs from the recording. Some differences are deliberate; some are ambient: a request id, a UUID in tool arguments, a temp path the agent names anew on every run. Normalizers tell Shadowlap which parts of a request are not part of its identity. Today's date needs none: [dates and times](#dates-and-times) near a run's start already match.

```sh
shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'
shadowlap normalize add --kind tool --name create_ticket --path '$.args.idempotency_key' --replace '<ID>'
shadowlap normalize ls
shadowlap normalize rm 2
```

### What a rule masks

A rule is a pattern, a path, or both:

| Rule | Masks |
|---|---|
| `--pattern` alone | what the pattern matches, in every string of the request |
| `--path` and `--pattern` | what the pattern matches, in the value at the path |
| `--path` alone | the whole value at the path, whatever it is |

`normalize add` takes these options, and `redact add` takes the same:

| Flag | What it does | Default |
|---|---|---|
| `--path` | A JSONPath subset: `$.a.b[0].c`, `[*]` and `.*` wildcards, `["quoted key"]`. For tool calls the arguments are under `$.args`. | — |
| `--pattern` | A named pattern (`iso-date`, `iso-datetime`, `uuid`, `ulid`, `number`, `email`) or a `/regex/flags` literal, checked before it ever runs | — |
| `--kind` | Scopes the rule to a kind of call: `api`, `tool`, `clock`, `random`; a redaction rule takes `api` or `tool` | — |
| `--name` | Scopes the rule to a name: a tool name, or `POST /v1/messages` | — |
| `--replace` | What a match becomes | `<MASKED>`; `<REDACTED>` for a redaction rule |
| `--expect <version>` | Refuses the edit when the file is no longer that version ([Editing the file](#editing-the-file)) | — |

### What `add` refuses

`add` refuses these, with the reason:

- **A rule with neither a path nor a pattern**, which would change nothing.
- **A pattern that can match no text at all**, such as `/x*/`, `/\b/` or `/(?=sk-)/`, which would insert the replacement instead of masking anything.
- **`--path '$'` with no pattern** unless `--name` scopes it to one tool or call, which would make every call look the same.
- **A pattern or path it can't read.**
- **A pattern that could take too long**: see [Patterns that could take too long](#patterns-that-could-take-too-long).

Adding a rule that is already there changes nothing.

### List and remove rules

`ls` numbers the rules, and `rm` takes that number (`2` or `#2`), or the tool name, path or pattern of exactly one rule: `shadowlap normalize rm create_ticket`.

- **Numbers move up.** The rules after a removed one move up a number.
- **`ls --json`** prints the file, its version and every rule with its number.
- **A rule the config can no longer load** is listed with the reason, so `rm` can take it out.

### Rules that can't be loaded

A rule that can't be loaded (a misspelled pattern, a path that isn't one, a pattern that could take too long) stops only what applies it, with its number and the reason:

| Rule | Stops |
|---|---|
| A broken normalizer | `run`, `replay`, `calibrate` and `test` |
| A broken redaction rule | `pack`, the exports and `redact preview`, never a recording |

The dashboard opens either way, and a run downloaded from it as HTML is refused, not shared without the rule.

A pattern is at most 10,000 characters long wherever it is written. The other limits `add` puts on a rule's length are for what a command line or the dashboard sends. A long name, path or replacement you write into the file yourself loads as it is.

### Patterns that could take too long

A pattern runs on every string of every request and response, while recording, replaying and copying. A JavaScript regular expression backtracks: one of the wrong shape tries every way to split a text among its parts. So `/(a+)+$/` takes time that doubles with each character, and stalls on thirty of them.

So a pattern is read before anything compiles it, wherever it was written: in `shadowlap.config.json`, through `add` and the dashboard, and in a pack or the team store, where someone else wrote it. It is refused, saying which rule and which part of it to change, when it holds:

- **A backreference** (`\1`, `\k<name>`), which matching can only check by trying every split of the text.
- **Inside a part that repeats** (`*`, `+`, or `{n,m}` with m over 1), a choice the next character doesn't settle:
  - a quantifier that can stop or go on at a character that can come after it (`(a+)+`, `(\w+\s?)*`, `(.*,)+`, `(.*a){12}`);
  - one that repeats a part that can match nothing;
  - alternatives that can start with the same character (`(a|ab)*`, `(\w|\d)+`).
- **Outside one**, either of these, since either takes the cube of a line's length:
  - more than one repeated part the next character doesn't settle (`.*a.*b`), groups or not, counting a part that follows one it overlaps with something after it that can fail (`[a-z]*[a-z]*!`, `[^b]*a[^b]*b`);
  - more than ten choices in all that the next character doesn't settle (`a?` written out 25 times).
- **More than 10,000 characters.**

**What passes.** Which characters each part can start with, and which can come after it, is read with the case-insensitive flag and Unicode properties (`\p{L}`) as the pattern has them. A part that ends at a character it can't take itself passes:

- the card pattern below, `/\b(?:\d[ -]?){13,16}\b/`, repeats an optional separator that only a digit can follow;
- `/(?:[\w-]+\.)+[a-z]{2,}/` repeats parts that each end at a dot.

A pattern that doesn't compile is refused with the engine's reason in plain words (`/(/: it isn't a regular expression: unterminated group`).

**How long one that passes takes.** A pattern that passes takes time in proportion to the text at each place it is tried, times at most the text's length where it has a repeated part that runs on. `/.*x/` reads a long line once for each place it could start, and so does `/[\w.+-]+@/` on a long word. Anchor such a pattern, or bound it (`/[^\n]{0,200}x/`).

**The time limit.** So that no rule stalls a recording, a replay or a copy, the rules applied to one document run within 5 seconds. That is a request a replay matches, a response or an error rewritten, or a copy made.

- **Past the limit**, they are stopped where they are, inside a match if need be, and the command names them.
- **A replay of a pack** whose rule runs that long answers that call with why, and goes on.
- **The dashboard's redaction preview and HTML download** end their own threads at their limits instead, and say which rule may be at fault.

### Hints from a replay

Normalizers apply at match time: adding one makes older recordings match too. The parent's fingerprints are recomputed from its stored requests under the current rules when a replay starts.

When a divergence is only a date, time, UUID or ULID, the report proposes the rule:

```
  hint: this looks like a UUID; to ignore it in matching, add a normalizer
        shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'
```

The TUI's actions palette adds it with one key.

## Dates and times

An agent that writes "Today is 2026-09-16" into its prompt sends a different request tomorrow. So before matching, Shadowlap reads every date, timestamp and epoch value within about a day of the run's own start as a placeholder: `<date>`, `<datetime>` or `<epoch>`. The recording's "today" and the replay's "today" then match, however far apart the two runs are, and a golden recorded in June still replays in September.

It recognizes these, in model requests and tool arguments:

| Format | Examples |
|---|---|
| ISO dates and timestamps, with or without an offset | `2026-09-16`, `2026-09-16T10:31:22Z` |
| HTTP dates | `Wed, 16 Sep 2026 10:31:22 GMT` |
| JavaScript's `Date.toString()` | — |
| English dates, with or without the weekday | `September 16, 2026`, `16 Sep 2026` |
| Epoch seconds and milliseconds | `time.time()`, `Date.now()` |

- **Only values near a run's start are masked.** A date a week earlier stays as it is. So changing "since 2026-09-09" to "since 2026-09-02" still forks, and the diff shows that change without the dates that were "today".
- **It affects matching only.** Stored requests keep their values, and the agent's clock is never changed, so a live call after a fork carries the real time: request signing depends on it.

**Both starts.** A replay reads both sides against both starts, its own and the recording's. What it serves back from the recording, a tool's result or `now()`, carries the recording's dates into its requests: a ticket's `created_at` the model is shown, or "Today is" written from `now()`. A request the replay sends as it was recorded then matches, however long after the recording it runs.

**A fixed date near the recording.** A fixed date that happens to fall within a day of when a run was recorded is masked in that recording and not in a later replay, so it forks. The report says so, and `calibrate` proposes no rule for it, since one would hide the whole value.

To match dates exactly, set `"clock": "exact"` in `shadowlap.config.json`, and add normalizers where you need them. For example, for the date in a system prompt:

```sh
shadowlap normalize add --kind api --path '$.system[0].text' --pattern iso-date
```

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

Run it after your first recording, and again when a replay forks for a reason you didn't cause. It makes no model calls, and writes are blocked while it runs.

- **Which run.** Without a run named, it takes the newest finished recording made here: one that completed or failed, not one imported from a pack or a capture. With none, it says to record a run first.
- **Already clean.** A recording that already replays clean ends with "This recording replays clean with the current rules. Nothing to add."
- **`--write`** adds the proposals to `shadowlap.config.json` and says their numbers.
- **`--json`** prints the run, how it was chosen (`source`: `given` or `newest`), every round, the proposals with why each was proposed, and the numbers `--write` gave them. A dashboard job that runs calibrate gets the same object as its result.
- **A value in the middle of a longer string.** The proposed pattern is anchored on the fixed text before it, so it masks only that value.
- **A change that isn't a value in a request.** When the agent makes a different call, because it iterates a set or picks something at random, calibration stops and shows the divergence. Read that value through the SDK's `uuid()` or `now()`, or make the choice deterministic.

### The design rule

Nothing is excluded from matching implicitly, with three exceptions:

- **`cache_control` markers are stripped**, because the provider documents them as behavior-neutral and agents move them routinely.
- **Dates and times near a run's start are masked**, because by construction each means the current time in its own run.
- **Claude Code's session identifier in `metadata.user_id` is masked**, because Claude Code makes one for every session, machine and account, and it is no part of the prompt. It is told by its form, so another agent's `user_id` still counts.

Stripping keys by name everywhere would silently merge genuinely different requests, and a false replay hit returns the wrong response with no signal. A false divergence is visible and fixable.

## Redaction

Recordings contain everything the agent saw: prompts, tool inputs and outputs, and any user data in them. Before a pack leaves your machine, mask what shouldn't:

```sh
shadowlap redact add --pattern email
shadowlap redact add --kind tool --path '$.args.api_key' --replace '<KEY>'
shadowlap redact add --pattern '/\b(?:\d[ -]?){13,16}\b/' --replace '<CARD>'
shadowlap redact preview
shadowlap pack <run> ./share/run
```

Rules take the same forms as normalizers, scoped by `--kind api` or `--kind tool`. The replacement is `<REDACTED>` when it is left out, or left empty: a rule never deletes what it matches. `redact ls` and `redact rm` work as they do for normalizers.

Credentials sent the way providers and services take them never need redacting: [Credentials](#credentials) lists what Shadowlap masks by itself.

### What a rule masks in a pack

`pack` applies the rules to a scratch copy of the run, and the local store is never modified. `--no-redact` skips the rules.

**A rule without a path** masks what its pattern matches in these places:

| Where | How it is read |
|---|---|
| Every string of every request | as written |
| A model call's query string | each parameter read as `name=value`, with both decoded |
| Every string of a response or tool result that is JSON | keys included, its numbers and layout kept as recorded |
| Each event of a streamed response | the same way: an event's data that is JSON, by its strings |
| The raw text of any other response | as written |
| An attempt's error | as written |
| A clock or random read | never: see [What a call got back](#what-a-call-got-back) |

- **Query strings are read decoded**: `customer=alice@example.com` where the query has `customer=alice%40example.com`, so a lookbehind on the name works too.
- **Numbers stay numbers**, so a timestamp a card-number pattern would match still replays as that number. In a stream, a token count stays a number and the event stays JSON.
- **A streamed response is masked across its events too**, since the model's text arrives in pieces no rule sees whole. Each block's text and each tool call's arguments are masked as the text they add up to.

**A rule with a path** masks the value at its path in every request:

- with no pattern, it replaces the whole value there, a number or an object included;
- with one, it masks what the pattern matches in a string there, and leaves anything else as it is.

A path rule masks only at its path. A tool argument the model wrote also appears in the conversation sent back to the model (`$.messages[…].content[…].input`). So mask a value that can appear there with a pattern, or a path for each place it appears.

### Call names

- **A [captured HTTP call](./sdk.md#http-services-without-wrapping)** is named after the path it asked for (`GET crm.example.com/contacts/alice@example.com`). So a rule without a path that reaches the call (every call, tool calls, or that call by `--name`) masks its name as it masks its URL.
- **Its replay.** A replay of the pack matches the call by its masked name, and a rule written for the call by the name it had before still applies to it there.
- **A rule scoped to it by `--name`** carries that name, and what its path holds, into every copy, since a copy records its rules. Scope a rule for a captured call with `--kind tool` instead, unless its name holds nothing the rules hide.
- **A model call** is named after its API path, and a rule without a path masks each of its segments read decoded, as the provider reads it.

A Bedrock model's ARN is one such segment (`arn%3Aaws%3Abedrock%3Aus-east-1%3A123456789012%3A…`). So a rule that masks an AWS account id (`/\b\d{12}\b/`) masks it there, as it masks it in a body. It masks it in the header parameters the call keeps for its identity (a Bedrock guardrail's ARN) and the model it ended with, too. A replay of the pack reads the live call's path and header parameters through the same rules, so it matches the masked copy.

### The run's record

- **What the run's record repeats** of that content is masked by the rules without a path too: a fork's flags, the divergence report, the checks' labels and details and a [judge check](./judges.md)'s reason. So is the last blame's: the checks it judged its attempts by, and the request fields its probes changed.
- **A judge's own request**, which Shadowlap built from what the judge read with the rules already applied, takes the rules without a path and never one with a path. A path names a place in the agent's requests, which in a judge's request would be its instructions or its whole question.
- **The run's command line, labels and notes** are copied as they are, but for the credentials the command line carries ([Command lines](#command-lines)), because a replay of the pack runs that command. `export html`, which is only ever read, masks them too.
- **The copy records its rules**, and a replay of it applies them as normalizers, so it still replays clean. A rule that lists the values it hides (an alternation of customer names) travels with every copy that way.

### What a call got back

What a call got back (a response, a tool's result, an error) is what a replay of the pack hands the agent. So a pack keeps it as recorded, but for the strings a rule without a path masks.

A value masked whole there, a number turned into the text `<CARD>`, would make the replayed agent act on it differently than the recording did. It would compute with it or send it on in another form, and the replay would fork: in CI, where the pack is all there is.

- **A copy that is only ever read** (`export html`, `har` and `dataset`) also applies a rule with a path to what a call got back: a response or tool result that is JSON, and an attempt's error.
- **Their paths.** A tool's result is stored as `{"result": …}`, so `$.result.card`; an error is read as `{"error": …}` (`$.error.data.card`).
- **Never reached that way**: `$` alone, and a path that starts with a wildcard.
- **A clock or random read** is reached by no rule at all, with a path or without one. What the rules match in one, the preview counts as left as it is.

The run's time and randomness stay as recorded in every copy, since the agent builds on them. A ticket's ref cut from the uuid it read would be cut from `<REDACTED>` on replay, and fork at the next call that sends it.

### Signed reasoning

A model's provider signs its thinking, and checks the signature when the agent sends a thinking block back in a later request. So a pack keeps a model call's signed reasoning as recorded, in its requests and in what it got back, whatever the rules:

| Provider | Signed reasoning |
|---|---|
| Anthropic, on Bedrock and Vertex too | `thinking` and `redacted_thinking` blocks; in a stream, their `thinking_delta` and `signature_delta` events |
| Bedrock Converse | `reasoningContent` |
| Gemini | `thoughtSignature` |
| OpenAI | a reasoning item's `encrypted_content` |
| OpenRouter | signed `reasoning_details` |

A fork of a pack whose thinking a rule had rewritten would send back a block that no longer matches its signature, and the provider would refuse its first live call. Everything around a block is masked as usual.

What a rule matches inside signed reasoning leaves with the pack, so `pack` names each rule that does and the calls it does it in:

```
packed 1 run (2 calls, 7 blobs) to goldens/refund with 2 redaction rules
  ! redaction rule #1 (every call  any string  email → <REDACTED>) matches inside signed reasoning in calls #1, #2, which the pack keeps as recorded: a fork sends it back and the provider refuses a signed block that has been changed. What it matches there leaves with the pack.
  ! redaction rule #2 (every call  any string  /[A-Za-z0-9+/]{40,}/ → <TOKEN>) matches inside signed reasoning in calls #1, #2, which the pack keeps as recorded: a fork sends it back and the provider refuses a signed block that has been changed. What it matches there leaves with the pack.
```

The second rule, written for long tokens, matched the thinking blocks' signatures.

- **The [preview](#preview)** counts it among what a pack leaves as it is.
- **A thinking text a stream sends in pieces** is read whole, as the pieces add up.
- **A copy that is only read** (`export html`, `har`, `dataset`, a share link) masks signed reasoning like any other text, since it is never sent back.

### Replacements

Because a replay applies the rules a second time, `redact add` refuses a replacement the pattern would rewrite again (`--pattern number --replace n0` turns into `nn0`). It also refuses a replacement that copies matched text back into the copy (`$&`, `$1`, `$<name>`, `` $` `` or `$'`); `$$` is a literal dollar sign. To keep the text around a secret, match only the secret, with a lookbehind for what comes before it: `--pattern '/(?<=key=)\w+/'`. Redaction is pattern-based: it masks what your rules describe and nothing else, so preview it, and review a pack before sharing it.

### Where the rules apply

Every export, pack and share link applies the rules, and Shadowlap's tests hold each to this table. "The run's details" are its command line, labels and notes.

| Copy | Rules it applies | The run's details |
|---|---|---|
| `shadowlap pack` | every rule on the requests it copies; the rules without a path on what calls got back | copied as recorded, but for the command line's credentials |
| `shadowlap export html` | every rule, as `pack` applies them, and the rules with a path on what calls got back too | masked by the rules without a path |
| `shadowlap export har` | every rule on its model calls' requests and responses, as `export html` applies them; the rules without a path on URLs and headers | not in a HAR, nor are tool calls |
| `shadowlap export dataset` | every rule on the conversations and answers it keeps, as `export html` applies them; then the rules without a path on the rest of each row | masked |
| `shadowlap export pairs` | on the conversations and answers it keeps: path rules on the request and tool arguments and results; the rules without a path on every string | not in a pair |
| `shadowlap export otel` | the rules without a path, on span names, model and tool names, and error messages | the command line, masked |
| `shadowlap share` | every rule, always, as `export html` applies them | as `export html` |
| `shadowlap repair`, to the repairer | every rule, as `export html` applies them; the rules without a path on how the run fails | not shown to the repairer |

**`shadowlap pack`** applies every rule to the requests it copies, a model call's query string included. The rules without a path apply to the strings of what calls got back and the errors with them, which a replay hands the agent as recorded otherwise. A clock or random read and a model call's [signed reasoning](#signed-reasoning) stay as recorded. The run's details are copied as recorded, but for the credentials the command line carries: a replay runs the command.

**`shadowlap export html`** masks signed reasoning like any text. It masks the run's details by the rules without a path, with the run's checks and divergence; who made the run and the folder it was recorded in are left out.

**`shadowlap export otel`**: a trace carries no prompt text. **`shadowlap share`**: the link opens the run's HTML report to anyone who has it.

**`shadowlap repair`** applies every rule to the system prompt, tool descriptions, conversation and two answers it shows the repairer. The spans a fix may rewrite are your source, shown as they are. The answers `report.md` (a pull request's body) quotes are the masked ones too.

A push copies runs to your [team store](./team.md) as recorded, so teammates can replay them, but for the credentials Shadowlap masks by itself. The bucket's own permissions decide who reads them.

**`--no-redact`.** Each export that applies rules takes `--no-redact`, and stops, naming the rule, when one can't be read. `share` takes no `--no-redact`. `repair` always applies them, and stops the same way before it blames anything.

### Preview

`shadowlap redact preview [run]` shows what the rules would mask in a run, before you export, pack or share it, and writes nothing. The run's stored requests, responses and errors, retries included, go through the same functions `pack` applies, which say what they change as they change it. So it counts what a pack changes:

- the strings of a JSON document, and not its numbers;
- a value a stream splits across events;
- the whole values a path rule replaces in a request;
- a captured HTTP call's name, apart from its URL;
- a model call's query string;
- each attempt's response headers;
- what the run's own record repeats of that content, which a pack masks as well: a fork's flags, the divergence report, the checks' labels and details and a judge check's reason, and the last blame's.

Without a run named, it takes the newest run that has ended; a run still recording is refused. A conversation sends its earlier messages again with every request, and the preview reads each of them once. So it takes time in proportion to the run's length: a run of 1,200 model calls takes about a second.

With the three rules above, `redact preview` prints this for one run:

```
01M2R1HDVD (node agent.js): 5 values would be masked, 2 left as they are
  #1  every call  any string  email → <REDACTED>  3
        - …customers. The account owner is alice@example.com.
        + …customers. The account owner is <REDACTED>.
        - Refund order 4417 for bob@example.com
        + Refund order 4417 for <REDACTED>
  #2  tool  $.args.api_key  whole value → <KEY>  1
        - sk-live-123
        + <KEY>
  #3  every call  any string  /\b(?:\d[ -]?){13,16}\b/ → <CARD>  1
        - paid with 4111 1111 1111 1111
        + paid with <CARD>
        2 left as they are:
        = 1792155242516  call 1 clock now, response $.result
        = 4111111111111111  call 3 tool lookup_order, response $.result.card
        a path rule masks the whole value at its path, numbers included:
          shadowlap redact add --kind tool --name refund_card --path '$.args.card' --replace '<CARD>'
        a pack keeps what a call got back, since its replay hands it to the agent; export html, har and dataset mask it with:
          shadowlap redact add --kind tool --name lookup_order --path '$.result.card' --replace '<CARD>'
        a clock or random read stays as recorded: a replay needs it
```

**What each rule shows.** Each rule shows how many values it would mask, and up to two of them before and after, cut to the change. A value counts once wherever it goes: one a conversation sends again with every later request, an answer that is in its response and in the next request, an address the model's tool call and the tool's arguments both hold.

**A rule that masks nothing** says why:

- no matches in the run;
- matches only in numbers, in what a clock or random read returned, or in signed reasoning;
- no call of its kind or name;
- no request (or response) with its path;
- a path whose values don't match its pattern;
- a path only in what calls got back, which a pack keeps.

For such a rule the copies that are read mask something a pack doesn't. A line under it says how many values `export html`, `har` and `dataset` mask in what calls got back, with two of them, and the first line of the preview adds them up.

**What a pack leaves as it is.** Under a rule comes what it matches that a pack leaves as it is, apart from its count. A copy masks strings, so these stay as recorded:

- a number in a JSON document;
- the keys of a request or an error (a response's keys are strings like any other there, and are masked);
- all of a clock or random read;
- a model call's signed reasoning;
- what a path rule's pattern matches in a number at its path, or inside an object or list there, since the pattern applies only to a string at its path.

Each such value counts once, with up to two of them and where each is: the call, its request, response or error (and in a stream, the event), and the path there.

**What masks each value.** What masks each, for each place it was found, comes after them:

- **In a request**: a path rule. It masks the whole value at its path, numbers included, in every copy, a pack among them.
  - The preview gives the command, scoped to the call's kind and, for a tool, its name, with the rule's replacement.
  - Positions in a list read as `[*]`, so the rule masks the value in every message or item alike. For a key, it is the object that holds it.
  - For what a path rule's pattern leaves inside an object at its path, it is the same rule at the value's own path: its pattern for a string there, the whole value for a number. So a rule on `$.messages[*].content` gets one on `$.messages[*].content[*].text`, never one that wipes the whole content.
- **In what a call got back**: a pack keeps it, since its replay hands it to the agent. The copies that are read mask it with a path rule there, and the preview gives that command too, or names the rule that already does.
- **None**, and the preview says which, for a value:
  - in a clock or random read: the run's time or randomness, which a replay needs as recorded;
  - in signed reasoning, which a pack keeps as recorded, since the provider checks it;
  - in a streamed response's events: no path reaches into a stream;
  - that is the whole request or response, or a key at its top: no path names it apart from all of it;
  - under a key a path can't name, one holding `]`.

Above, the card-number rule leaves the time the agent read as it is, and the card the refund tool was sent gets its rule. The card the lookup returned is masked by `export html`, `har` and `dataset` once its rule is added.

**Up to 20 commands.** The commands come for the requests first, up to 20 in all. Past that it says how many places are left, and after you add these, the next preview lists them. Run a command and preview again: the value moves into the count.

The run's details come on a line of their own, since the exports differ on them. The line counts what the rules without a path match in the run's command line, labels and notes, which `export html`, `dataset` and `otel` mask. `pack` copies them as recorded, but for the command line's credentials, which every copy masks.

For a run whose command line and a note hold e-mail addresses, the preview prints:

```
  the run's command line, labels and notes: 2 (#1)  masked by export html, dataset and otel; pack copies them as recorded, since a replay runs the command
        - node agent.js --customer erin@example.com
        + node agent.js --customer <REDACTED>
```

The command line is read as one text, its arguments joined by spaces, and every copy that carries it masks it that way, as text or as its list of arguments. So `--pattern '/(?<=--api-key )\S+/'` masks the key in `--api-key sk-live-…` everywhere the line goes.

- **`--json`** prints the same object, with `returned` and `unmasked` at its top and under each rule. `details` holds that line: its count, samples and the rules that match. [The CLI reference](./cli.md#normalize-redact) lists every field.
- **A dashboard job** that runs the preview gets that object as its result.
- **Settings → Redaction** in the dashboard shows the same preview, with what a rule leaves as it is on a quiet line under it.
- **An imported run** is named by the file it came from.

## Credentials

Credentials sent the way providers and services take them never need redacting. Shadowlap keeps them out of what it stores as it records, and every copy masks them again. This section lists each rule.

### Model calls

- **Key and authorization headers.** A model call's API key and authorization headers are forwarded upstream and never stored.
- **The query string** is kept without the credentials in it.
- **Account headers.** OpenAI's `openai-organization` and `openai-project`, and Anthropic's `anthropic-organization-id`, are never stored.

### Captured HTTP calls

A [captured HTTP call](./sdk.md#http-services-without-wrapping)'s request headers are never stored either. The credentials in its query string and its body are stored as `<CREDENTIAL>`, and so are those its response hands back, in its body and in its headers.

- **Masked in place.** Each is masked in place, the rest of the body kept as the service sent it, its numbers included, however long.
- **Real values for the agent.** The agent gets the real values as it records, and a client that reads its token from the response still finds it there on replay.
- **Matching.** A body is matched with its credentials masked as it is stored, so a replay with a rotated secret still replays. So does a recording an earlier version made of a body it stored as sent.
- **A `set-cookie`** is never stored.

### Body shapes

A captured call's body, and its response's body, is read by its shape, whatever its content type says:

| Shape | What is read |
|---|---|
| A form | each parameter, by its name |
| JSON, also sent as text or with no type | each member whose name is a credential, at any depth |
| JSON behind a byte-order mark or an anti-XSSI prefix | the JSON after `)]}'` or `while(1);` |
| A JSONP call | the JSON it carries |
| JSON objects among other text | each object: after a comment, before a `;`, run together, in a page's script such as `__NEXT_DATA__` |
| Lines of JSON (NDJSON) | each line; a line that isn't JSON among them is left as it is |
| A multipart body | its fields and parts |
| An event stream | its `data:` lines, each event's read joined as a client reads them |
| XML and HTML | elements and attributes, an element named by its `name` or `key` attribute as by its tag |
| `key: value` and `key = value` lines | YAML, an INI file, a .env file |
| A GraphQL query | its inline arguments (`login(password: "…")`) and block strings |
| A body that isn't UTF-8 | read byte for byte |

In XML and HTML that covers `<entry key="db.password">`, `<input name="SAMLResponse" value="…">`, a SAML attribute's values, and an STS answer's `SecretAccessKey`.

**Inside a body:**

- **Under a credential member**, every string is one: `api_keys: […]`, `client_secret: {value: …}`.
- **A JWT** is one whatever its member is named, and wherever it stands in a text: after `Bearer `, in a sentence.
- **A string is read by its shape too**: JSON in it, a query string, a connection string (`AccountKey=…;`, `Password=…;`), and a URL.
- **In a URL**: its query, its fragment, a path's `;jsessionid=`, the password in `postgres://app:…@db`, and a token given as its user name.
- **The password of any URL a text holds**, wherever it stands: `DATABASE_URL=postgres://app:…@db` in a .env file, a URL in a sentence or a log line.

**In a response's body**, read the same way, that covers an OAuth token response's `access_token` and `refresh_token`, and an STS answer's `SecretAccessKey` and `SessionToken`.

### Names that hold a credential

A parameter or member is a credential by the words of its name, in any case and however they are joined:

| Kind | Names |
|---|---|
| Keys | `key`, `api_key`, `api-key`, `apiKey`, `x-api-key`, `subscription-key` (Azure API Management) |
| Tokens | `access_token`, `refresh_token`, `id_token`, `token` |
| Client secrets and proofs | `client_secret`, `client_assertion`, `code_verifier` |
| Passwords and auth | `password`, `auth`, `jwt` |
| Signatures | `sig`, `signature`, a presigned URL's `X-Amz-Signature`, `X-Amz-Credential` and `X-Amz-Security-Token` |
| Sessions and sign-ins | a `cookie`, a one-time password (`otp`, `mfa_code`), a `SAMLResponse` |
| TLS keys | `tls.key`, `tls_key` |
| Lists of them | `api_keys`, `refresh_tokens`, `recovery_codes` |
| A password or secret word anywhere in it | `password_confirmation`, `SecretString`, `secret_value` |

**Names that describe a secret.** A name with a password or secret word whose last words name or describe the secret, rather than hold it, keeps a value that doesn't read as a key. So lookups of two secrets stay two calls. Its last words name:

| What they name | Examples |
|---|---|
| Its name, ARN, version or stage | `secret_name`, `SecretArn`, `secret_version_id`, `SecretVersionStages` |
| A policy | `password_policy` |
| The e-mail address a reset goes to | `password_reset_email` |
| Its length, count, type, description or tags | — |
| Its rotation's settings | `secret_rotation_enabled` |
| When it was created, updated, expires or was last changed | `password_expires_at`, `secret_last_rotated_date` |
| Where it is kept, a reference to it, or its id | `secret_path`, Databricks' `secret_scope`, `secret_namespace`, Kubernetes' `secretKeyRef`, AWS's `SecretId` by a name, an ARN or a path |

Under such a name:

- **A key is masked**, as a count header's is: `secret_name: "ghp_…"`.
- **An object or a list under it**, or an element named so in XML, is masked through, as a credential member's is, when any string in it reads as a key: `{"secret_version": {"value": "ghp_…"}}`.
- **Vault AppRole's `secret_id`**, a UUID, reads as a key, so it stays masked.
- **Read by its name alone**, as a model call's query and a redirect's parameters are, such a name is a credential too.
- **A hint or a URL** doesn't describe the secret: a hint is often the password itself, and a reset link carries its token in its URL. Either is a credential whatever its value.

**Names that never are:**

| Kind | Examples |
|---|---|
| A piece of a word | `monkey`, `keyword`, `author` |
| A count | `tokens`, `input_tokens`, `max_tokens` |
| A cursor or a lookup | `page_token`, `sort_key`, `error_code` |

**Names read by their value:**

| Name | Where | A credential |
|---|---|---|
| A bare `key`, `token` or `code` | a captured call | when its value reads as one (`?key=AIzaSy…`, not `?key=checkout_v2`), since a lookup by key is common there |
| A bare `key`, `token` or `code` | a model call's query | always |
| `session`, `sid`, `ticket`, `appsecret_proof` | a query string or a form | always |
| `sk`, `ak`, `hash` | a query string or a form | when their value reads as one; in a model call's query, always |

### Secret stores

A secret store's answer holds the secret under a member whose name says nothing of one. It is read by the answer's shape, in a body a call sends (a Secret's manifest) and in a string (a tool's result) too:

| Store | Told by | Masked |
|---|---|---|
| A Kubernetes Secret | its `kind`, before them or after | every entry of its `data` and `stringData` (`tls.key`, `.dockerconfigjson`), and of a SecretList's items |
| Google Cloud Secret Manager | a version's `name` of `projects/…/secrets/…/versions/…` | `payload.data`, and `dataCrc32c`, the checksum that would confirm a guess of it |
| Azure Key Vault | an `id` under `https://….vault.azure.net/secrets/`, or another Azure cloud's vault | the secret's `value` |
| Vault's KV engine, version 2 | a `metadata` with a `version` | `data.data`, every field of it |
| Vault's KV engine, version 1 | a read of a path under `/v1/secret/`, where Vault mounts it by default | the answer's `data`, but for a list of the secrets' names (`{"keys": […]}`) none of which reads as a key |

What names the secret stays as sent: its name, id, type, metadata, attributes and tags.

### Headers

The value of a response header that carries a credential is stored as `<CREDENTIAL>`:

- `authorization`, `proxy-authorization` and any `*-authorization`;
- OpenStack's `x-subject-token`, Swift's `x-auth-token`, GitLab's `private-token`;
- `x-access-token`, `x-refresh-token`, `x-csrf-token`, `x-vault-token`, and AWS's `x-amzn-oidc-data`;
- any `*-auth` or `*-session`;
- any whose value is a JWT, alone or after its scheme;
- any whose name is a credential by the words in [Names that hold a credential](#names-that-hold-a-credential);
- any with a token, secret, password or credential word anywhere in its name, such as `x-session-token-raw`.

These are kept, on these terms:

| Header | Kept |
|---|---|
| A page's token, such as `x-next-page-token` | as sent |
| A count or a limit of tokens, such as Bedrock's `x-amzn-bedrock-input-token-count` | as sent only as a count of at most 12 digits, a time (RFC 3339 or an HTTP date) or a duration (`6m0s`) |
| Azure's `azureml-model-session` | only as Azure writes it (`d065-20240606224238`) |

Any other value of theirs is masked. `azureml-model-session` is a routing hint that signs nobody in: it names the deployment's session that served the call.

**Never stored:** a `set-cookie`, OpenAI's `openai-organization` and `openai-project`, and Anthropic's `anthropic-organization-id`.

**URLs in headers.** The credentials in a URL a header names are masked in place:

| Header | What is masked |
|---|---|
| A redirect's `location`, `content-location`, `x-original-url`, `x-original-uri`, `x-forwarded-uri` | the credentials in its URL |
| htmx's `hx-redirect`, `hx-location`, `hx-push-url` and `hx-replace-url` | the credentials in its URL |
| `link` | the credentials in each URL |
| `refresh` | the credentials in its URL |
| `www-authenticate`, `proxy-authenticate` | the challenge's token |

The credentials in such a URL are the code or token in its query or fragment, or in a URL inside one; a path's session; and its password, or a token given as its user name.

### URL paths

In a URL's path, these are credentials too, from any host:

- a path parameter named as one (`;jsessionid=…`);
- a webhook's secret: the last segment of Slack's `/services/T…/B…/<secret>` (and its `/workflows/` and `/triggers/` addresses), Slack's at the root of its path;
- the token after the id in Discord's `/api/webhooks/<id>/<token>`;
- a Telegram bot's token in `/bot<id>:<token>/`.

A captured call named after that address is stored with it masked in its name as well.

### Command lines

Every copy masks the credentials the agent's command line carries, rules or none: a pack, an HTML report and a share link, a push, `export otel` and `export dataset`. So do a fix's blames, verdicts and repairs, which keep their command lines masked and push the flags kept to run each again masked too.

**Flags and arguments:**

| Form | What is masked |
|---|---|
| A flag that takes a credential, by the names above: `--api-key <value>`, `--api-key=<value>`, or with one dash, as Go's flags are written (`-token <value>`) | its value |
| A bare `--token`, `--session`, `--sid`, `--ticket`, `--auth` or `--signature` | its value, whatever it is |
| `--key` or `--code` | its value, when it reads as one |
| A flag that says where the credential is: `--token-file`, `--api-key-env`, `--password-stdin` | nothing |
| An assignment whose name reads as a credential: `OPENAI_API_KEY=…` after `env`, `--set auth.password=…` | its value, to the end of the argument it is in |
| Any other assignment: `DATABASE_URL=postgres://app:…@db`, git's `-c http.extraheader=AUTHORIZATION: …` | the URL's password, the JWT or the header line it gives |
| A header line: `-H 'Authorization: Bearer …'` | its credential |
| A JWT given as an argument of its own | all of it |
| A URL | its password, query credentials and webhook secret |
| Any argument's text: one with a space or an `=` in it, or JSON | a URL's password, a JWT, and what the body masking reads in text (`key: value` lines, a form, JSON members) |

**Passwords under a name that doesn't say so:**

| Program | Option | What is masked |
|---|---|---|
| curl | `-u user:…`, `--user`, `--proxy-user` | the password; the user kept |
| httpie | `-a` | the password |
| mysql's and mariadb's tools | `-p…`, glued | the password; a word after a bare `-p` is the database |
| mongo's tools, sshpass | `-p`, glued or not | the password |
| docker, podman, nerdctl | `login -p` | the password |
| redis-cli | `-a` | the password |
| sqlcmd, bcp | `-P` | the password |
| An LDAP tool | `-w` | the password |
| smbclient | `-U user%…` | the password |
| curl | `-d`, `--data`, `--data-raw`, `--data-binary`, `--data-urlencode`, `--json`, `-F` | the body, read as a form or as JSON, its other fields kept |

Anywhere else, `-p` is a port or a path, and kept.

**Scripts a program runs** are read word by word, as a shell reads them:

| Program | Script |
|---|---|
| A POSIX shell | `-c`: `sh -c 'OPENAI_API_KEY=… node agent.js'`, `bash -lc '…'` |
| ssh | the remote command |
| Shadowlap | a `--build` script |
| cmd | `/c` |
| PowerShell | `-Command` |
| Python | `-c` |
| Node | `-e` |
| Ruby, Perl | `-e` |

In a script, each form above is masked, and an assignment's value to the end of its word. Each word that changes is written in the quotes its language wrote it in (`os.environ['GITHUB_TOKEN']='<CREDENTIAL>'`), and the rest of the script is kept.

**What runs.** The store keeps the command line as it ran, since a replay runs it again. A pack's replay elsewhere runs `<CREDENTIAL>` in its place, so give it your own key there. A golden packed here still runs as recorded here: its command is the store's, but for what the pack masks.

### What isn't masked

A key the agent puts anywhere else is stored like any other value, so mask it with a [redaction rule](#redaction):

- in a wrapped tool's arguments or result, whatever its name;
- under a name that reads as none in a captured call's body, such as a secret a call writes to a store in a body that doesn't say what it holds;
- in a Kubernetes Secret written as YAML;
- in a prompt;
- in another part of a URL's path.

A body that doesn't say what it holds is one sent to Vault, Azure Key Vault or Secret Manager, or a patch of a Kubernetes Secret's `data`; a whole Secret's manifest says so.

**Encoded secrets.** So is a key left encoded, as masking reads what a credential is written as, and not what it is encoded into:

- base64, such as JSON a form field carries, or a JWE;
- percent-encoding twice;
- a string nested more than six deep (an event stream inside an event's data is one level);
- UTF-16.

**Compressed bodies.** So is a body stored compressed as it came: a request body the agent compressed, and an answer under two content encodings at once (`gzip, br`), which the sidecar passes on as it came, without its `content-encoding`. No rule reads a body stored as bytes (compressed, UTF-16) either, so keep a key out of those.

### Bodies masking can't read

A body masking can't read at all is stored as `<CREDENTIAL>` whole:

- one longer than a string can hold (about 512 MB);
- one whose thread stopped before it was stored, out of memory or as the sidecar closed.

The call goes through as sent. But two such calls to one address hold the same arguments, so a replay matches them by their order, and another upload sent in place of one gets its answer.

Nothing of the bytes is kept to tell them apart: their length would still match two uploads of one size, and a hash of them lets a short secret among them be guessed from the rest. Wrap an upload that large as a tool whose arguments say what it sends, if a replay has to tell two of them apart.

### Recordings made by an earlier version

Every copy masks these again in a recording an earlier version made, when they weren't yet known to be credentials, except in the error a call ended with. That covers a pack (with `--no-redact` too), an HTML report and a share link, a HAR, and a push to the [team store](./team.md).

A replay of such a recording reads a live call the way the recording was stored, so it still matches:

| A recording made | Stored | A replay of it |
|---|---|---|
| Before a secret's name was kept: it has no [`secretNames`](./recording-format.md#a-run) | the name as `<CREDENTIAL>` | masks a live call's the same way to match it, and stores them so too |
| Before a value under such a name was read | a key there, as sent | masks it on both sides, so the recording replays as it did, and stores it masked |
| Marked `secretNames: true`, before a path, a ref, a scope, a namespace or an id was kept | those as `<CREDENTIAL>` | reads them the same way, and is marked `true` too |

- **Matched by order.** In the first case, where the names were all that told two calls apart, a replay matches them by the calls' order, so its own replays match the same way.
- **Two lookups by `SecretId`** in a recording marked `secretNames: true` still match by their order.

## Editing the file

`normalize add` and `rm`, `redact add` and `rm`, and `calibrate --write` edit `shadowlap.config.json` through one editor, with the same checks.

### One edit at a time

An edit takes `shadowlap.config.json.lock` beside the file, and waits up to 2 seconds for another to finish. The lock names the process holding it:

| Lock | Taken over |
|---|---|
| One whose process is gone | at once |
| On Linux and macOS, one whose process still runs on this machine | never |
| One that can't be checked that way | after 10 seconds untouched |

A lock can't be checked that way when it was written on another machine, or in a container that shares the folder, or when it doesn't say who holds it. On Windows, which can't tell a running holder from a process given a dead holder's id, neither can one whose process id is in use.

A writer only ever removes its own. An edit refused for the lock names it, to delete if no Shadowlap command is running.

### Never half written

- **A temporary file, renamed.** An edit writes `.shadowlap.config.json.<pid>.<random>.tmp` beside the file and renames it over the file, so the file is never half written.
- **The lock, linked.** The lock is written whole to a temporary file of its own first, then linked to its name.
- **What a crash leaves.** These files are gone when the edit ends. A crash in the middle can leave one, or the `shadowlap.config.json.lock.break` an edit holds while it removes a lock left by a crash, which the next edit ignores and you can delete.
- **A writable folder.** So editing needs the project folder to be writable, not only the file: in a read-only folder an edit says so and changes nothing.
- **A read-only file.** A config file you made read-only stays as it is: an edit refuses it.

### What an edit keeps

- **Every other key.** Every key the edit doesn't touch keeps its place and its value, keys this version doesn't know included.
- **Formatting.** The file keeps its indentation and line endings.
- **`--expect <version>`** on `add` and `rm` refuses the edit when the file is no longer the version `ls --json` printed. So a script that read rule #2 never removes a rule someone added in the meantime.

### The activity log

Adding and removing a rule is recorded in the project's activity with who did it, in a store that exists: editing the config never creates one.

- **A normalizer** is named by its path (`normalizer.added`, `normalizer.removed`, with the rule). Calibrate's are marked `via: calibrate`.
- **A redaction rule** is named by its replacement (`redaction.added`, `redaction.removed`). Its pattern can hold the very text it hides, so the activity log never carries it.

## See also

- [The CLI reference for `normalize` and `redact`](./cli.md#normalize-redact): every flag, and the preview's JSON fields.
- [Team store](./team.md): what a push and a share link carry.
- [Recording format](./recording-format.md): how a pack records the rules it was made with.
- [Security](https://github.com/devjoinedthechat/shadowlap/blob/main/SECURITY.md): what each copy masks, and every other check Shadowlap makes.
