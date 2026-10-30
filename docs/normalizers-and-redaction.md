# Normalizers and redaction

Both are rewrite rules with the same shape: an optional scope (`kind`, `name`), an optional JSONPath, a pattern, and a replacement. **Normalizers** mask values before fingerprinting and never touch what is stored. **Redaction rules** mask stored content when a run is exported, and are then applied as normalizers when that export is replayed, so a redacted recording still matches.

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

## Normalizers

A replay diverges when a request differs from the recording. Some differences are deliberate; some are ambient: a request id, a UUID in tool arguments, a temp path the agent names anew on every run. Normalizers tell Shadowlap which parts of a request are not part of its identity. Today's date needs none: [dates and times](#dates-and-times) near a run's start already match.

```sh
shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'
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
- `--pattern` is a named pattern (`iso-date`, `iso-datetime`, `uuid`, `ulid`, `number`, `email`) or a `/regex/flags` literal, checked before it ever runs ([Patterns that could take too long](#patterns-that-could-take-too-long)).
- Scope with `--kind` (`api`, `tool`, `clock`, `random`) and `--name` (a tool name, or `POST /v1/messages`).
- `--replace` is what a match becomes; `<MASKED>` when it is left out.

`add` refuses, with the reason: a rule with neither a path nor a pattern, which would change nothing; a pattern that can match no text at all, such as `/x*/`, `/\b/` or `/(?=sk-)/`, which would insert the replacement instead of masking anything; `--path '$'` with no pattern unless `--name` scopes it to one tool or call, which would make every call look the same; a pattern or path it can't read; and a pattern that could take too long. Adding a rule that is already there changes nothing.

`ls` numbers the rules, and `rm` takes that number (`2` or `#2`), or the tool name, path or pattern of exactly one rule: `shadowlap normalize rm create_ticket`. The rules after a removed one move up a number. `ls --json` prints the file, its version and every rule with its number; a rule the config can no longer load is listed with the reason, so `rm` can take it out.

A rule that can't be loaded (a misspelled pattern, a path that isn't one, a pattern that could take too long) stops only what applies it, with its number and the reason: a broken normalizer stops `run`, `replay`, `calibrate` and `test`; a broken redaction rule stops `pack`, the exports and `redact preview`, never a recording. The dashboard opens either way, and a run downloaded from it as HTML is refused, not shared without the rule. A pattern is at most 10,000 characters long wherever it is written. The other limits `add` puts on a rule's length are for what a command line or the dashboard sends; a long name, path or replacement you write into the file yourself loads as it is.

### Patterns that could take too long

A pattern runs on every string of every request and response, while recording, replaying and copying. A JavaScript regular expression backtracks: one of the wrong shape tries every way to split a text among its parts, so `/(a+)+$/` takes time that doubles with each character and stalls on thirty of them. So a pattern is read before anything compiles it, wherever it was written: in `shadowlap.config.json`, through `add` and the dashboard, and in a pack or the team store, where someone else wrote it. It is refused, saying which rule and which part of it to change, when it holds:

- a backreference (`\1`, `\k<name>`), which matching can only check by trying every split of the text;
- inside a part that repeats (`*`, `+`, or `{n,m}` with m over 1), a choice the next character doesn't settle: a quantifier that can stop or go on at a character that can come after it (`(a+)+`, `(\w+\s?)*`, `(.*,)+`, `(.*a){12}`), one that repeats a part that can match nothing, or alternatives that can start with the same character (`(a|ab)*`, `(\w|\d)+`);
- outside one, more than one repeated part the next character doesn't settle (`.*a.*b`), counting a part that follows one it overlaps, with something after it that can fail (`[a-z]*[a-z]*!`, `[^b]*a[^b]*b`), groups or not, since either takes the cube of a line's length; or more than ten choices in all that the next character doesn't settle (`a?` written out 25 times);
- more than 10,000 characters.

Which characters each part can start with, and which can come after it, is read with the case-insensitive flag and Unicode properties (`\p{L}`) as the pattern has them. A part that ends at a character it can't take itself passes: the card pattern below, `/\b(?:\d[ -]?){13,16}\b/`, repeats an optional separator that only a digit can follow, and `/(?:[\w-]+\.)+[a-z]{2,}/` repeats parts that each end at a dot. A pattern that doesn't compile is refused with the engine's reason in plain words (`/(/: it isn't a regular expression: unterminated group`).

A pattern that passes takes time in proportion to the text at each place it is tried, times at most the text's length where it has a repeated part that runs on: `/.*x/` reads a long line once for each place it could start, and so does `/[\w.+-]+@/` on a long word. Anchor such a pattern, or bound it (`/[^\n]{0,200}x/`). So that no rule stalls a recording, a replay or a copy, the rules applied to one document (a request a replay matches, a response or an error rewritten, a copy made) run within 5 seconds: past that they are stopped where they are, inside a match if need be, and the command names them. A replay of a pack whose rule runs that long answers that call with why and goes on. The dashboard's redaction preview and HTML download end their own threads at their limits instead, and say which rule may be at fault.

Normalizers apply at match time: adding one makes older recordings match too, because the parent's fingerprints are recomputed from its stored requests under the current rules when a replay starts.

When a divergence is only a date, time, UUID or ULID, the report proposes the rule:

```
  hint: this looks like a UUID; to ignore it in matching, add a normalizer
        shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'
```

The TUI's actions palette adds it with one key.

## Dates and times

An agent that writes "Today is 2026-09-16" into its prompt sends a different request tomorrow. So before matching, Shadowlap reads every date, timestamp and epoch value within about a day of the run's own start as a placeholder: `<date>`, `<datetime>` or `<epoch>`. The recording's "today" and the replay's "today" then match, however far apart the two runs are, and a golden recorded in June still replays in September.

It recognizes ISO dates and timestamps (`2026-09-16`, `2026-09-16T10:31:22Z`, with or without an offset), HTTP dates (`Wed, 16 Sep 2026 10:31:22 GMT`), JavaScript's `Date.toString()`, English dates (`September 16, 2026`, `16 Sep 2026`, with or without the weekday), and epoch seconds and milliseconds (`time.time()`, `Date.now()`), in model requests and tool arguments.

- Only values near a run's start are masked. A date a week earlier stays as it is, so changing "since 2026-09-09" to "since 2026-09-02" still forks, and the diff shows that change without the dates that were "today".
- A replay reads both sides against both starts, its own and the recording's. What it serves back from the recording, a tool's result or `now()`, carries the recording's dates into its requests: a ticket's `created_at` the model is shown, or "Today is" written from `now()`. A request the replay sends as it was recorded then matches however long after the recording it runs.
- It affects matching only. Stored requests keep their values, and the agent's clock is never changed, so a live call after a fork carries the real time. Request signing depends on it.
- A fixed date that happens to fall within a day of when a run was recorded is masked in that recording and not in a later replay, so it forks. The report says so, and `calibrate` proposes no rule for it, since one would hide the whole value. Set `"clock": "exact"` in `shadowlap.config.json` to match dates exactly, and add normalizers where you need them, such as `shadowlap normalize add --kind api --path '$.system[0].text' --pattern iso-date` for the date in a system prompt.

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

Without a run named, it takes the newest finished recording made here (one that completed or failed, not one imported from a pack or a capture); with none, it says to record a run first. A recording that already replays clean ends with "This recording replays clean with the current rules. Nothing to add." `--write` adds the proposals to `shadowlap.config.json` and says their numbers; `--json` prints the run, how it was chosen (`source`: `given` or `newest`), every round, the proposals with why each was proposed, and the numbers `--write` gave them; a dashboard job that runs calibrate gets the same object as its result.

It makes no model calls, and writes are blocked while it runs. Run it after your first recording, and again when a replay forks for a reason you didn't cause. For a value in the middle of a longer string, the proposed pattern is anchored on the fixed text before it, so it masks only that value. When a change isn't a value in a request (the agent makes a different call, because it iterates a set or picks something at random), calibration stops and shows the divergence: read that value through the SDK's `uuid()` or `now()`, or make the choice deterministic.

**The design rule behind this:** nothing is excluded from matching implicitly, with three exceptions. `cache_control` markers are stripped, because the provider documents them as behavior-neutral and agents move them routinely. Dates and times near a run's start are masked, because by construction they mean "now" in both runs. Claude Code's session identifier in `metadata.user_id` is masked, because Claude Code makes a new one for every session, machine and account, and it is no part of the prompt; it is told by its form, so another agent's `user_id` still counts. Stripping keys by name everywhere would silently merge genuinely different requests, and a false replay hit returns the wrong response with no signal; a false divergence is visible and fixable.

## Redaction

Recordings contain everything the agent saw: prompts, tool inputs and outputs, and any user data in them. Before a pack leaves your machine, mask what shouldn't:

```sh
shadowlap redact add --pattern email
shadowlap redact add --kind tool --path '$.args.api_key' --replace '<KEY>'
shadowlap redact add --pattern '/\b(?:\d[ -]?){13,16}\b/' --replace '<CARD>'
shadowlap redact preview
shadowlap pack <run> ./share/run
```

Rules take the same forms as normalizers, scoped by `--kind api` or `--kind tool`; the replacement is `<REDACTED>` when it is left out (or left empty: a rule never deletes what it matches). `redact ls` and `redact rm` work as they do for normalizers.

`pack` applies the rules to a scratch copy of the run. A rule without a path masks what its pattern matches in every string of every request, and in a model call's query string, each parameter read as `name=value` with both decoded (`customer=alice@example.com` where the query has `customer=alice%40example.com`, so a lookbehind on the name works too); in every string of a response or tool result that is JSON, keys included, its numbers and layout kept as recorded, so a timestamp a card-number pattern would match still replays as that number; in each event of a streamed response the same way (an event's data that is JSON by its strings, so a token count stays a number and the event stays JSON); in the raw text of any other response; and in an attempt's error; never in a clock or random read (below). A rule with a path masks the value at its path in every request: with no pattern it replaces the whole value there, a number or an object included; with one it masks what the pattern matches in a string there, and leaves anything else as it is. A streamed response is masked across its events too, since the model's text arrives in pieces no rule sees whole: each block's text and each tool call's arguments are masked as the text they add up to. A [captured HTTP call](./sdk.md#http-services-without-wrapping) is named after the path it asked for (`GET crm.example.com/contacts/alice@example.com`), so a rule without a path that reaches the call (every call, tool calls, or that call by `--name`) masks its name as it masks its URL. A replay of the pack matches the call by its masked name, and a rule written for the call by the name it had before still applies to it there. A model call is named after its API path, and a rule without a path masks each of its segments read decoded, as the provider reads it: a Bedrock model's ARN is one (`arn%3Aaws%3Abedrock%3Aus-east-1%3A123456789012%3A…`), so a rule that masks an AWS account id (`/\b\d{12}\b/`) masks it there, and in the header parameters the call keeps for its identity (a Bedrock guardrail's ARN) and the model it ended with, as it masks it in a body; a replay of the pack reads the live call's path and header parameters through the same rules, so it matches the masked copy. That rule carries the name, and what its path holds, into every copy, since a copy records its rules: scope a rule for a captured call with `--kind tool` instead, unless its name holds nothing the rules hide. The local store is never modified. What the run's record repeats of that content is masked by the rules without a path too: a fork's flags, the divergence report, the checks' labels and details and a [judge check](./judges.md)'s reason, and the last blame's (the checks it judged its attempts by and the request fields its probes changed). A judge's own request, which Shadowlap built from what the judge read with the rules already applied, takes the rules without a path and never one with a path: that names a place in the agent's requests, which in a judge's request would be its instructions or its whole question. The run's command line, labels and notes are copied as they are, but for the credentials the command line carries (below), because a replay of the pack runs that command; `export html`, which is only ever read, masks them too. The copy records its rules, and a replay of it applies them as normalizers, so it still replays clean; a rule that lists the values it hides (an alternation of customer names) travels with every copy that way. `--no-redact` skips the rules.

What a call got back (a response, a tool's result, an error) is what a replay of the pack hands the agent, so a pack keeps it as recorded but for the strings a rule without a path masks. A value masked whole there, a number turned into the text `<CARD>`, would make the replayed agent act on it differently than the recording did, computing with it or sending it on in another form, and the replay would fork: in CI, where the pack is all there is. A copy that is only ever read, `export html`, `har` and `dataset`, also applies a rule with a path to what a call got back: a response or tool result that is JSON (a tool's result is stored as `{"result": …}`, so `$.result.card`) and an attempt's error, read as `{"error": …}` (`$.error.data.card`). `$` alone and a path that starts with a wildcard are never reached that way. A clock or random read is reached by no rule at all, with a path or without one: the run's time and randomness stay as recorded in every copy, since the agent builds on them (a ticket's ref cut from the uuid it read would be cut from `<REDACTED>` on replay, and fork at the next call that sends it). What the rules match in one, the preview counts as left as it is.

A path rule masks only at its path. A tool argument the model wrote also appears in the conversation sent back to the model (`$.messages[…].content[…].input`), so mask a value that can appear there with a pattern, or a path for each place it appears.

### Signed reasoning

A model's provider signs its thinking, and checks the signature when the agent sends a thinking block back in a later request. A pack keeps a model call's signed reasoning as recorded, in its requests and in what it got back, whatever the rules: Anthropic's `thinking` and `redacted_thinking` blocks (on Bedrock and Vertex too, and in a stream their `thinking_delta` and `signature_delta` events), Bedrock Converse's `reasoningContent`, Gemini's `thoughtSignature`, an OpenAI reasoning item's `encrypted_content`, and OpenRouter's signed `reasoning_details`. A fork of a pack whose thinking a rule had rewritten would send back a block that no longer matches its signature, and the provider would refuse its first live call. Everything around a block is masked as usual.

What a rule matches inside signed reasoning leaves with the pack, so `pack` names each rule that does and the calls it does it in:

```
packed 1 run (2 calls, 7 blobs) to goldens/refund with 2 redaction rules
  ! redaction rule #1 (every call  any string  email → <REDACTED>) matches inside signed reasoning in calls #1, #2, which the pack keeps as recorded: a fork sends it back and the provider refuses a signed block that has been changed. What it matches there leaves with the pack.
  ! redaction rule #2 (every call  any string  /[A-Za-z0-9+/]{40,}/ → <TOKEN>) matches inside signed reasoning in calls #1, #2, which the pack keeps as recorded: a fork sends it back and the provider refuses a signed block that has been changed. What it matches there leaves with the pack.
```

The second rule, written for long tokens, matched the thinking blocks' signatures.

The [preview](#preview) counts it among what a pack leaves as it is. A thinking text a stream sends in pieces is read whole, as the pieces add up. A copy that is only read (`export html`, `har`, `dataset`, a share link) masks signed reasoning like any other text, since it is never sent back.

Because a replay applies the rules a second time, `redact add` refuses a replacement the pattern would rewrite again (`--pattern number --replace n0` turns into `nn0`). It also refuses a replacement that copies matched text back into the copy (`$&`, `$1`, `$<name>`, `` $` `` or `$'`); `$$` is a literal dollar sign. To keep the text around a secret, match only the secret, with a lookbehind for what comes before it: `--pattern '/(?<=key=)\w+/'`. Redaction is pattern-based: it masks what your rules describe and nothing else, so preview it, and review a pack before sharing it.

Credentials sent the way providers and services take them never need redacting. A model call's API key and authorization headers are forwarded upstream and never stored, and its query string is kept without the credentials in it. A [captured HTTP call](./sdk.md#http-services-without-wrapping)'s request headers are never stored either. The credentials in its query string and its body are stored as `<CREDENTIAL>`, the body read by its shape whatever its content type says: a form; JSON, also sent as text or with no type, behind a byte-order mark or an anti-XSSI prefix (`)]}'`, `while(1);`), or in a JSONP call (each member whose name is a credential, at any depth); lines of JSON (NDJSON); a multipart body's fields and parts; an event stream's `data:` lines; XML and HTML elements and attributes (an STS answer's `SecretAccessKey`, an element named by its `name` or `key` attribute); a GraphQL query's inline arguments (`login(password: "…")`) and block strings; `key: value` and `key = value` lines (YAML, an INI file, a .env file); the JSON objects among other text (after a comment, before a `;`, in a page's script); and a body that isn't UTF-8, read byte for byte. Inside a body, every string under a credential member is one (`api_keys: […]`, `client_secret: {value: …}`), a JWT is one whatever its member is named, and a string is read by its shape too: JSON in it, a URL (its query, its fragment, a path's `;jsessionid=`, the password in `postgres://app:…@db`, a token given as its user name), a query string, a connection string (`AccountKey=…;`, `Password=…;`), and wherever it stands in a text, a JWT and the password of a URL. So are those its response hands back, in its body read the same way and in its headers: the value of a response header that carries one (`authorization`, `proxy-authorization`, any `*-authorization`, OpenStack's `x-subject-token`, Swift's `x-auth-token`, GitLab's `private-token`, `x-access-token`, `x-refresh-token`, `x-csrf-token`, `x-vault-token`, AWS's `x-amzn-oidc-data`, any `*-auth` or `*-session`, any whose value is a JWT, any whose name is a credential by the words below, and any with a token, secret, password or credential word anywhere in its name, but a page's token such as `x-next-page-token`; a count or a limit of tokens, such as Bedrock's `x-amzn-bedrock-input-token-count`, and Azure's `azureml-model-session`, which names the deployment's session that served the call, are kept as sent unless their value reads as a key), the credentials in a URL a header names (a redirect's `location`, `content-location`, `x-original-url`, `x-original-uri`, `x-forwarded-uri`, htmx's `hx-redirect`, `hx-location`, `hx-push-url` and `hx-replace-url`, each URL of a `link`, a `refresh`'s: its query and fragment, a URL inside one, a path's session, its password) and in a `www-authenticate` or `proxy-authenticate` challenge, and its body's credentials (an OAuth token response's `access_token` and `refresh_token`). Each is masked in place, the rest of the body kept as the service sent it, its numbers included, however long. The agent gets the real values as it records, and a client that reads its token from the response still finds it there on replay. A `set-cookie` is never stored, and neither are OpenAI's `openai-organization` and `openai-project` or Anthropic's `anthropic-organization-id`. A body is matched with its credentials masked as it is stored, so a replay with a rotated secret still replays, and so does a recording an earlier version made of a body it stored as sent. A recording made before a secret's name was kept stored it as `<CREDENTIAL>` (it has no [`secretNames`](./recording-format.md#a-run)): a replay of it masks a live call's the same way to match it, by the calls' order where the names were all that told them apart, and stores them so too, so its own replays match the same way.

A parameter is a credential by the words of its name, in any case and however they are joined: `key`, `api_key`, `api-key`, `apiKey`, `x-api-key`, `subscription-key` (Azure API Management), `access_token`, `refresh_token`, `id_token`, `token`, `client_secret`, `client_assertion`, `code_verifier`, `password`, `auth`, `jwt`, `sig`, `signature`, a presigned URL's `X-Amz-Signature`, `X-Amz-Credential` and `X-Amz-Security-Token`, a `cookie`, a one-time password (`otp`, `mfa_code`), a `SAMLResponse`, and lists of them (`api_keys`, `refresh_tokens`, `recovery_codes`). So is a name with a password or secret word anywhere in it (`password_confirmation`, `SecretString`, `secret_value`), but one whose last words name or describe the secret rather than hold it, which keeps its value so that lookups of two secrets stay two calls: its name, ARN, version or stage (`secret_name`, `SecretArn`, `secret_version_id`, `SecretVersionStages`), a policy (`password_policy`), the e-mail address a reset goes to (`password_reset_email`), its length, count, type, description or tags, its rotation's settings (`secret_rotation_enabled`), and when it was created, updated, expires or was last changed (`password_expires_at`, `secret_last_rotated_date`). An id stays a credential (Vault's `secret_id` signs in, though AWS's `SecretId` only names a secret, so two lookups by `SecretId` match each other in their order), and so do a hint, which is often the password itself, and a URL, which a reset link carries its token in. Read by its name alone, as a model call's query and a redirect's parameters are, such a name is a credential too. A piece of a word never is (`monkey`, `keyword`, `author`), nor a count (`tokens`, `input_tokens`, `max_tokens`), a cursor or a lookup (`page_token`, `sort_key`, `error_code`). On a captured call, a bare `key`, `token` or `code` is a credential when its value reads as one (`?key=AIzaSy…`, not `?key=checkout_v2`), since a lookup by key is common there; in a model call's query it always is. In a query string or a form, `session`, `sid`, `ticket` and `appsecret_proof` are credentials too, and `sk`, `ak` and `hash` when their value reads as one (in a model call's query, always). In a URL's path, so is a path parameter named as one (`;jsessionid=…`) and a webhook's secret: the last segment of Slack's `/services/T…/B…/<secret>` (and its `/workflows/` and `/triggers/` addresses), the token after the id in Discord's `/api/webhooks/<id>/<token>`, and a Telegram bot's token in `/bot<id>:<token>/`, from any host, Slack's at the root of its path; a captured call named after that address is stored with it masked in its name as well.

Every copy masks these again in a recording an earlier version made, when they weren't yet known to be credentials, but in the error a call ended with: a pack (with `--no-redact` too), an HTML report and a share link, a HAR, and a push to the [team store](./team.md). A key the agent puts anywhere else is stored like any other value, so mask it with a rule: in a wrapped tool's arguments or result, whatever its name; under a name that reads as none in a captured call's body; in a prompt; or in another part of a URL's path. So is one left encoded, as masking reads what a credential is written as and not what it is encoded into (base64, such as JSON a form field carries; percent-encoding twice; a string nested more than six deep; UTF-16), and a body stored compressed as it came: a request body the agent compressed, and an answer under two content encodings at once (`gzip, br`). No rule reads a body stored as bytes (compressed, UTF-16) either, so keep a key out of those.

Every copy also masks the credentials the agent's command line carries, rules or none: a pack, an HTML report and a share link, a push, `export otel` and `export dataset`. That is the value of a flag that takes one, written `--api-key <value>`, `--api-key=<value>` or with one dash (`-token <value>`, as Go's flags are written), by the names above (a bare `--token`, `--session`, `--sid`, `--ticket`, `--auth` and `--signature` whatever their value, `--key` and `--code` when it reads as one), but not a flag that says where the credential is (`--token-file`, `--api-key-env`, `--password-stdin`); an assignment, to the end of the argument it is in (`OPENAI_API_KEY=…` after `env`, `--set auth.password=…`; in `sh -c 'OPENAI_API_KEY=… node agent.js'` the rest of the script goes too, so give a key through `env` or the environment); a header line (`-H 'Authorization: Bearer …'`); a JWT given as an argument of its own; and a URL's password, query credentials and webhook secret. The store keeps the command line as it ran, since a replay runs it again; a pack's replay elsewhere runs `<CREDENTIAL>` in its place, so give it your own key there. A golden packed here still runs as recorded here: its command is the store's, but for what the pack masks.

### Where the rules apply

Every export, pack and share link applies the rules; Shadowlap's tests hold each to this list. "The run's details" are its command line, labels and notes. A push copies runs to your [team store](./team.md) as recorded, so teammates can replay them, but for the credentials above; the bucket's own permissions decide who reads them.

| Export | Applies | The run's details |
|---|---|---|
| `shadowlap pack` | every rule on the requests it copies, a model call's query string included; the rules without a path on the strings of what calls got back and the errors with them, which a replay hands the agent as recorded otherwise, but for a clock or random read and a model call's [signed reasoning](#signed-reasoning), which stay as recorded | copied as recorded, but for the credentials the command line carries: a replay runs the command |
| `shadowlap export html` | every rule, as `pack` applies them, the rules with a path on what calls got back too, and signed reasoning masked like any text | masked by the rules without a path, with the run's checks and divergence; who made the run and the folder it was recorded in are left out |
| `shadowlap export har` | every rule on the model calls it holds, as `export html` applies them to their requests and responses, and the rules without a path on URLs and headers | not in a HAR, nor are tool calls |
| `shadowlap export dataset` | every rule on the conversations and answers it keeps, as `export html` applies them, then the rules without a path on the rest of each row | masked |
| `shadowlap export pairs` | the rules on the conversations and answers it keeps: path rules on the request and on tool arguments and results, and the rules without a path on every string | not in a pair |
| `shadowlap export otel` | a trace carries no prompt text; the rules without a path apply to its span names, model and tool names, and error messages | the command line, masked |
| `shadowlap share` | every rule, always, as `export html` applies them: the link opens the run's HTML report to anyone who has it | as `export html` |
| `shadowlap repair`, to the repairer | every rule on the system prompt, tool descriptions, conversation and two answers it shows the repairer, as `export html` applies them (the spans a fix may rewrite are your source, shown as they are), and the rules without a path on how the run fails; the answers `report.md` (a pull request's body) quotes are the masked ones too | not shown to the repairer |

Each export that applies rules takes `--no-redact`, and stops, naming the rule, when one can't be read; `share` takes no `--no-redact`. `repair` always applies them, and stops the same way before it blames anything.

### Preview

`shadowlap redact preview [run]` shows what the rules would mask in a run, before you export, pack or share it: the run's stored requests, responses and errors, retries included, go through the same functions `pack` applies, which say what they change as they change it, and nothing is written. So it counts what a pack changes: the strings of a JSON document and not its numbers, a value a stream splits across events, the whole values a path rule replaces in a request, a captured HTTP call's name apart from its URL, a model call's query string, each attempt's response headers, and what the run's own record repeats of that content, which a pack masks as well: a fork's flags, the divergence report, the checks' labels and details and a judge check's reason, and the last blame's. Without a run named it takes the newest run that has ended; a run still recording is refused. A conversation sends its earlier messages again with every request; the preview reads each of them once, so it takes time in proportion to the run's length (a run of 1,200 model calls takes about a second).

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

Each rule shows how many values it would mask and up to two of them before and after, cut to the change. A value counts once wherever it goes: one a conversation sends again with every later request, an answer that is in its response and in the next request, an address the model's tool call and the tool's arguments both hold. A rule that masks nothing says why: no matches in the run, matches only in numbers, in what a clock or random read returned or in signed reasoning, no call of its kind or name, no request (or response) with its path, a path whose values don't match its pattern, or a path only in what calls got back, which a pack keeps. For such a rule the copies that are read mask something a pack doesn't: a line under it says how many values `export html`, `har` and `dataset` mask in what calls got back, with two of them, and the first line of the preview adds them up.

Under a rule comes what it matches that a pack leaves as it is, apart from its count. A copy masks strings: a number in a JSON document stays as recorded, and so do the keys of a request or an error (a response's keys are strings like any other there, and are masked), all of a clock or random read, and a model call's signed reasoning; a path rule's pattern, too, applies only to a string at its path, so what it matches in a number there, or inside an object or list there, stays. Each such value counts once, with up to two of them and where each is: the call, its request, response or error (and in a stream, the event), and the path there.

What masks each, for each place it was found, comes after them:

- In a request, a path rule: it masks the whole value at its path, numbers included, in every copy, a pack among them. The preview gives the command, scoped to the call's kind and, for a tool, its name, with the rule's replacement; positions in a list read as `[*]`, so the rule masks the value in every message or item alike. For a key it is the object that holds it. For what a path rule's pattern leaves inside an object at its path, it is the same rule at the value's own path: its pattern for a string there, the whole value for a number, so a rule on `$.messages[*].content` gets one on `$.messages[*].content[*].text`, never one that wipes the whole content.
- In what a call got back, a pack keeps it, since its replay hands it to the agent. The copies that are read mask it with a path rule there, and the preview gives that command too, or names the rule that already does.
- None for a value in a clock or random read (the run's time or randomness, which a replay needs as recorded), in signed reasoning (which a pack keeps as recorded, since the provider checks it), in a streamed response's events (no path reaches into a stream), the whole request or response or a key at its top (no path names it apart from all of it), or under a key a path can't name (one holding `]`); the preview says which. Above, the card-number rule leaves the time the agent read as it is, the card the refund tool was sent gets its rule, and the card the lookup returned is masked by `export html`, `har` and `dataset` once its rule is added.

The commands come for the requests first, up to 20 in all; past that it says how many places are left, and after you add these, the next preview lists them. Run a command and preview again: the value moves into the count.

The run's details come on a line of their own, since the exports differ on them: what the rules without a path match in the run's command line, labels and notes, which `export html`, `dataset` and `otel` mask and `pack` copies as recorded (but for the command line's credentials, which every copy masks). The command line is read as one text, its arguments joined by spaces, and every copy that carries it masks it that way, as text or as its list of arguments, so `--pattern '/(?<=--api-key )\S+/'` masks the key in `--api-key sk-live-…` everywhere the line goes.

```
  the run's command line, labels and notes: 2 (#1)  masked by export html, dataset and otel; pack copies them as recorded, since a replay runs the command
        - node agent.js --customer erin@example.com
        + node agent.js --customer <REDACTED>
```

`--json` prints the same object, `returned` and `unmasked` at its top and under each rule (`details` holds that line: its count, samples and the rules that match), and a dashboard job that runs the preview gets it as its result; [the CLI reference](./cli.md#normalize-redact) lists every field. Settings → Redaction in the dashboard shows the same preview, with what a rule leaves as it is on a quiet line under it. An imported run is named by the file it came from.

## Editing the file

`normalize add` and `rm`, `redact add` and `rm`, and `calibrate --write` edit `shadowlap.config.json` through one editor, with the same checks:

- One edit at a time: an edit takes `shadowlap.config.json.lock` beside the file, and waits up to two seconds for another to finish. The lock names the process holding it: a lock whose process is gone is taken over at once, and on Linux and macOS one whose process still runs on this machine never is. A lock that can't be checked that way is taken over after ten seconds untouched: one written on another machine or in a container that shares the folder, one that doesn't say who holds it, and on Windows, which can't tell a running holder from a process given a dead holder's id, one whose process id is in use. A writer only ever removes its own. An edit refused for the lock names it, to delete if no Shadowlap command is running.
- An edit writes `.shadowlap.config.json.<pid>.<random>.tmp` beside the file and renames it over the file, so the file is never half written; the lock is written whole to a temporary file of its own first, then linked to its name. These files are gone when the edit ends; a crash in the middle can leave one, or the `shadowlap.config.json.lock.break` an edit holds while it removes a lock left by a crash, which the next edit ignores and you can delete.
- So editing needs the project folder to be writable, not only the file: in a read-only folder an edit says so and changes nothing. A config file you made read-only stays as it is: an edit refuses it.
- Every key the edit doesn't touch keeps its place and its value, keys this version doesn't know included, and the file keeps its indentation and line endings.
- `--expect <version>` on `add` and `rm` refuses the edit when the file is no longer the version `ls --json` printed, so a script that read rule #2 never removes a rule someone added in the meantime.

Adding and removing a rule is recorded in the project's activity with who did it, in a store that exists: editing the config never creates one. A normalizer is named by its path (`normalizer.added`, `normalizer.removed`, with the rule; calibrate's are marked `via: calibrate`), and a redaction rule by its replacement (`redaction.added`, `redaction.removed`): its pattern can hold the very text it hides, so the activity log never carries it.
