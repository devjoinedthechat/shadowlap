# The recording format

A recording is everything an agent run said to the world and heard back: each model call's request
and response, each tool call's arguments and result, each clock read and random value, numbered in
the order the run made them.

This page specifies recordings as Shadowlap writes and reads them, in two forms:

- **On disk, as a *pack***: a folder of plain files that can be committed as a [golden](./ci.md),
  attached to an issue or shared.
- **Over HTTP, as [the recordings protocol](#the-recordings-protocol)**, through which a test runner
  records a test and replays it.

A framework, a tracing tool or a test runner that writes packs gets recordings Shadowlap replays, and
one that reads them gets every run Shadowlap records.

Version 1. Packs and the protocol are versioned together ([Versions](#versions)), and Shadowlap is
the reference implementation: it replays an agent's real code against a recording, serving every call
that hasn't changed from it.

**Normative language.** MUST, SHOULD and MAY carry their usual weight. Where this page and Shadowlap
disagree, Shadowlap is what replays: [open an issue](https://github.com/devjoinedthechat/shadowlap/issues).

The reference implementation of packs is `@shadowlap/engine` ([the engine as a library](./engine.md)):

- `packRun` writes a pack, and `unpackRun` reads one;
- `validateRun` and `validateCall` check its records;
- `fingerprintApi`, `fingerprintTool` and `fingerprintMisc` compute identities.

The protocol's is `shadowlap serve --recordings`.

On this page:

- [A pack](#a-pack), [run.json](#runjson), [calls.jsonl](#callsjsonl) and [Blobs](#blobs): the files.
- [Identity](#identity): how a call's fingerprint is computed.
- [Partial recordings](#partial-recordings), [Reading a pack](#reading-a-pack) and
  [Writing a pack](#writing-a-pack), with a complete example.
- [The recordings protocol](#the-recordings-protocol), for a test runner.
- [Versions](#versions).

## A pack

A pack is a folder:

```text
refund-flow/
├── run.json          the runs
├── calls.jsonl       every call, one JSON object per line
├── blobs/            every request and response, one file each, named by its SHA-256
└── .gitattributes    * -text
```

- A pack MUST have `run.json`. `calls.jsonl` and `blobs/` MAY be left out of a pack whose runs made
  no calls.
- Every file in it MUST be a regular file. A reader refuses a symbolic link, and a name in `blobs/`
  that isn't a SHA-256.
- Anything else in the folder, such as a README, is not part of the pack: a reader ignores it, and a
  writer that replaces a pack (the same golden packed again) leaves it.
- `.gitattributes` holds `* -text`, so that git never converts a pack's line endings: a blob that no
  longer matches its name is refused. A writer SHOULD add it unless the folder has one.

## run.json

```json
{
  "format": "shadowlap-pack",
  "version": 1,
  "createdAt": 1790000001000,
  "runs": []
}
```

| Field | Type | Meaning |
|---|---|---|
| `format` | string | `"shadowlap-pack"` |
| `version` | integer | `1`, this page. A reader MUST refuse a version it doesn't know |
| `createdAt` | integer | When the pack was written, in milliseconds since the epoch, as every time here is |
| `runs` | array | 1 to 10,000 runs: the run packed, last, and before it any runs it was replayed from, root first |

### A run

Each run in `runs` has these fields. A field is required unless its type says optional.

| Field | Type | Meaning |
|---|---|---|
| `runId` | string | A ULID: 26 characters of Crockford base32 (`0-9`, `A-Z` without `I`, `L`, `O` and `U`) |
| `parentRunId` | string or `null`, optional | The run it replayed, or `null` for a recording. It may name a run the pack doesn't hold |
| `mode` | string | `record` or `replay` |
| `status` | string | `running`, `completed`, `failed` or `crashed`. A reader takes `running` as `crashed`: nothing records the run any more |
| `command` | object | `{ "argv": […], "cwd": "…" }`: the command that started the agent, 1 to 256 arguments, and the folder it ran in |
| `codeVersion` | string or `null`, optional | The git revision the run was made at, up to 128 characters, or `null` |
| `startedAt` | integer | When the run started |
| `endedAt` | integer or `null`, optional | When it ended, or `null` |
| `divergence` | object or `null`, optional | Where a replay forked, or `null`: its `type` (`request_changed`, `new_call`, `forced`, `beyond_recording` or `ended_early`), `callNo`, `kind` and `name` |
| `meta` | object, optional | An object of the keys below and any others: a reader MUST keep keys it doesn't know |

Some fields in more detail:

- **`command`**: `cwd` is for people to read. A reader runs `argv` in its own project folder, never in
  `cwd`, so a producer SHOULD write `.` or a path relative to the project, not an absolute path on its
  machine. Shadowlap writes the folder `shadowlap run` ran in.
- **A run made where nothing knows what started the agent**, such as a capture of production
  traffic, has `["<no-recorded-command>"]` as its `argv`. Replaying it then takes the agent's command
  after `--`.
- **`divergence`** also holds the calls `replayedBefore` it, and the
  [extra reads](./how-it-works.md#the-replay-state-machine) it answered live before it, when there
  were any (`extraReads`, each `callNo`, `kind` and `name`).

### Run meta

A run's `meta` may hold these keys:

| Field | Type | Meaning |
|---|---|---|
| `labels` | array of strings | Up to 50 labels, each 1 to 40 letters, digits, spaces and `_ . : / -`, starting with a letter or a digit |
| `notes` | array | Up to 1,000 notes, `{ "callNo": …, "text": "…", "at": … }`, with `callNo` `null` for a note on the run |
| `redactions` | array | The [redaction rules](./normalizers-and-redaction.md#redaction) applied to the pack's copy of the run |
| `covers` | array of strings | What a [partial recording](#partial-recordings) holds |
| `inputs` | boolean | `true`: what a person typed during the run is recorded, as `user_input` tool calls ([the wire protocol](./protocol.md#user-input)) |
| `keyEnv` | object | The providers whose credentials the agent's environment held when it started, with the variables that held each key |
| `normalizersHash` | string | Under what the stored fingerprints were computed ([identity](#identity)). A producer leaves it out |
| `exactNumbers` | boolean | `true`: the run's model requests are stored with each number as it was sent ([identity](#identity)) |
| `headerParameters` | boolean | `true`: the run's model calls kept the parameters their provider takes as headers among their `fingerprintHeaders` |
| `secretNames` | number or boolean | `2` or `true`: how the run's captured calls keep a name that names or describes a secret ([identity](#identity)) |
| `imported` | object | Written by a reader that brings the run into a store: where it came from. A pack's own is replaced |

Some keys in more detail:

- **`redactions`**: a replay applies them as normalizers, so a live request matches the masked
  recording.
- **`keyEnv`** keeps names, never values. It maps each provider to the variables among those its SDKs
  read that held its key, such as `{ "anthropic": ["ANTHROPIC_API_KEY"], "bedrock": [] }`. The list
  is empty for a credential of another kind: a profile, a shared file, an identity.
- **`keyEnv` on replay**: `shadowlap replay` gives the agent a
  [placeholder key](./how-it-works.md#keys) for those providers when its environment has none. A
  reader takes only the providers and variables it knows; a producer may leave it out.
- **`exactNumbers`**: an integer past 2^53 is stored by its digits, and `20.0` as written.
- **`headerParameters`**: those parameters are Bedrock's guardrail, trace, latency profile and
  service tier ([identity](#identity)).

`secretNames` takes one of two values:

- **`2`**: the run's captured calls keep a name that names or describes a secret as sent, such as
  `secret_name`, `SecretId`, `secret_path` or `password_policy`, but for a value that reads as a key.
  A run without it stored `<CREDENTIAL>`.
- **`true`**: the same, but for a path, a ref, a scope, a namespace or an id, which it stored as
  `<CREDENTIAL>` too.

Shadowlap keeps more under `meta` (what a blame found, how a test judged the run, what a replay
changed); a producer leaves those out.

## calls.jsonl

One call per line, each a JSON object. A field is required unless its type says optional.

| Field | Type | Meaning |
|---|---|---|
| `runId` | string | A run in `run.json` |
| `callNo` | integer | 1, 2, 3… in the order the run made its calls; once per run |
| `kind` | string | `api`, `tool`, `clock` or `random` |
| `name` | string | Up to 512 characters. `api`: the method and the path, `POST /v1/messages`; `tool`: the tool's name; `clock`: `now`; `random`: `random` or `uuid` |
| `fingerprint` | string | The call's identity, 64 lowercase hex digits ([identity](#identity)) |
| `occurrence` | integer | 1 for the first call with that fingerprint, 2 for the second… |
| `origin` | string | What happened to the call in this run: `live`, `replayed`, `blocked`, `stubbed` or `overridden`. Every call of a recording is `live` |
| `effect` | string or `null`, optional | `pure`, `read` or `write` for a tool; `null` for every other kind |
| `requestRef` | string or `null`, optional | The blob holding the request, or `null` |
| `meta` | object, optional | An object of the keys below and any others, which a reader keeps |
| `at` | integer | When the call started |
| `end` | object or `null`, optional | How it ended, or `null` for a call the run never finished |
| `attempts` | array | Earlier ends of a call that was tried again, as an SDK retries a 429, first to last; `[]` otherwise |

### An end

An end, in `end` and in `attempts`, has these fields:

| Field             | Type             | Meaning                                |
|-------------------|------------------|----------------------------------------|
| `runId`, `callNo` | string, integer  | The call's                             |
| `attempt`         | integer          | 0 for the first, 1 for the next…       |
| `responseRef`     | string or `null` | The blob holding the answer, or `null` |
| `outcome`         | string           | `ok` or `error`                        |
| `meta`            | object           | An object                              |
| `at`              | integer          | When it ended                          |

### Call meta

A call's `meta` may hold these keys, written when the call starts:

| Field | Type | Meaning |
|---|---|---|
| `provider` | string | The API a model call's request was for: `anthropic`, `openai`, `gemini`, `bedrock`, `vertex`, `azure` or `ai-gateway` |
| `via` | string | The host of another provider's wire format a model call went through: `foundry`, `bedrock-mantle`, or a host the config declares |
| `fingerprintHeaders` | object | A model request's [fingerprint headers](#identity) as it sent them, names in lower case |
| `query` | string | The query string a model call was sent with, without `?` and without credentials (`alt=sse`, `api-version=2024-10-21`) |
| `scope` | string | The branch of the agent the call was made in ([scopes](./sdk.md#scopes)) |
| `implHash` | string | A hash of a tool's source, for the warning that it changed since the recording |
| `extraRead` | boolean | `true` on a replay's clock read, random value or pure tool call that its recording held no counterpart for |

An end's `meta` may hold these:

| Field | Type | Meaning |
|---|---|---|
| `status` | integer | A model response's HTTP status, 200 when left out |
| `headers` | object | A model response's headers, served with its body on replay |
| `chunks` | array | A model stream's events as `[byteOffset, msSinceFirstByte]` pairs, to play it back at its recorded pace |
| `retryable` | boolean | A model call's failure was one a client retries (429, 5xx) |
| `model` | string | The model that answered a model call |
| `usage` | object | `{ "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens" }` |
| `stopReason` | string | Why the model stopped |
| `latencyMs` | number | How long the call took |
| `error` | object | A failed call's error, `{ "name", "message", "code", "data" }`, the last two optional |

Some keys in more detail:

- **`provider`**: `ai-gateway` is Vercel's AI Gateway, in the AI SDK's own format. A reader needs
  `provider` to compute the call's fingerprint again.
- **`via`** is there when the call went through such a host, its `provider` being that format's.
  `foundry` is Claude on Microsoft Foundry, and `bedrock-mantle` OpenAI's SDK on Amazon Bedrock. A
  host the project's config declares under `providers` is named as declared
  ([Providers](./providers.md#hosts-of-another-providers-format)).
- **`query`** is `""` when the call had none, and is part of its [identity](#identity). A call that
  has no `query` was made before calls kept one, or comes from a source that never knew it.
- **`extraRead`** marks a call answered live while the replay went on
  ([extra reads](./how-it-works.md#the-replay-state-machine)).
- **`headers`**: `content-type` tells the client a stream (`text/event-stream`) from JSON.
- **`model`, `usage` and `stopReason`** are for costs and reports.

## Blobs

Every request and every answer is a blob: a file in `blobs/` whose name is the SHA-256 of its bytes,
in lowercase hex, stored uncompressed.

- A reader MUST refuse a blob whose bytes don't hash to its name.
- Every blob a call names, and every blob a request manifest names, the turns its runs name included,
  MUST be in the pack.
- A JSON blob is UTF-8. Its numbers are kept as written, so an id past 2^53 stays exact.

What each call's blobs hold:

| Kind | The request, at `requestRef` | The answer, at `end.responseRef` |
|---|---|---|
| `api` | A [request manifest](#request-manifests) | The response body as the agent got it, byte for byte |
| `tool` | `{"args": …}`, the arguments | `{"result": …}`, what the tool returned, or `{"error": …}`, what it raised |
| `clock` | `{"label": "…"}` | `{"result": …}`, milliseconds since the epoch |
| `random` | `{"label": "…"}` | `{"result": …}`: a number from 0 up to 1 for `random`, a UUID for `uuid` |

A model call's answer is JSON, or a stream's events, as the provider sent it or as Shadowlap answered
in its place (an offline replay's refusal, a failure `--fail-at` plays in). Its headers are in
`end.meta.headers`. There is none when no answer came: the connection broke first.

### Calls to declared HTTP hosts

A call to a host [declared under `http`](./sdk.md#http-services-without-wrapping) is a `tool` call
with `meta.http` naming the host:

| Part                                         | Holds                                                               |
|----------------------------------------------|---------------------------------------------------------------------|
| Arguments                                    | `{"method", "url", "body", "encoding"}`                             |
| Result                                       | `{"status", "headers", "body", "encoding"}`                         |
| An answer Shadowlap gave in the host's place | `{"error": …, "answer": {"status", "headers", "body", "encoding"}}` |

- **`encoding`** is `json`, `text` or `base64`, and the body is left out when there is none.
- **An answer Shadowlap gave** (a write blocked after a fork, an offline replay's refusal) is kept
  beside its error. A call whose connection closed with no answer keeps its error alone.
- **Credentials**: a captured call's `url`, `body`, and result `headers` and `body` hold
  `<CREDENTIAL>` where a credential was (`&lt;CREDENTIAL&gt;` in XML text).
- **A body masking couldn't read** is `{"body": "<CREDENTIAL>", "encoding": "text"}`, and a result's
  `headers` then `{}`. Two calls to one address whose bodies masking couldn't read have the same
  arguments, so a replay matches them by their order
  ([redaction](./normalizers-and-redaction.md#redaction) says when that is).

### Request manifests

A model request resends the whole conversation, so its parts are stored apart, and every part a run's
calls share is stored once. A request manifest is one of three kinds:

| Kind | `v` | For |
|---|--:|---|
| `chunked` | 1 | A body that is a JSON object with a `messages` array |
| `list` | 2 | A body that is a JSON object whose conversation is Gemini's `contents` or the Responses API's `input` items, an array |
| `whole` | 1 | Any other body |

Shadowlap writes version 1 for a `messages` body and version 2 for the others. A reader MUST read
both, and MUST refuse a manifest of a version it doesn't know.

**A *chunked* manifest:**

```json
{
  "v": 1,
  "kind": "chunked",
  "fields": { "model": "claude-haiku-4-5", "max_tokens": 256 },
  "system": null,
  "tools": null,
  "messages": []
}
```

- `system`, `tools` and each of `messages` name a JSON blob that holds that member of the body;
  `system` and `tools` are `null` when the body has none.
- `fields` holds every other member of the body.

**A *list*, a version 2 manifest:**

```json
{
  "v": 2,
  "kind": "list",
  "fields": { "generationConfig": { "temperature": 0 } },
  "parts": { "systemInstruction": "…" },
  "list": "contents",
  "runs": ["…", "…"]
}
```

| Field    | Type             | Meaning                                                                   |
|----------|------------------|---------------------------------------------------------------------------|
| `list`   | string           | The member that holds the conversation: `contents`, `input` or `messages` |
| `parts`  | object           | The members stored apart, each by the JSON blob that holds it             |
| `runs`   | array of strings | Blobs that each hold a JSON array of blob hashes                          |
| `fields` | object           | Every other member of the body                                            |

The members `parts` may name depend on `list`. A reader refuses any other:

| `list`     | `parts`                                               |
|------------|-------------------------------------------------------|
| `contents` | `systemInstruction`, `system_instruction` and `tools` |
| `input`    | `instructions` and `tools`                            |
| `messages` | `system` and `tools`                                  |

The conversation is the JSON blobs the runs name, run after run. A writer SHOULD make the runs'
lengths the binary digits of the conversation's length, largest first: 13 turns make runs of 8, 4
and 1. Then every call of a conversation shares each run that lies within the turns it has in common
with an earlier call. So the manifests of a run of n calls grow as n·log n, not n², as a list of
every turn's hash in each manifest does.

**A *whole* manifest**: `{ "v": 1, "kind": "whole", "blob": "…", "encoding": "json" }`. The blob holds
the body, and `encoding` says how to read it: `json`, `utf8`, or `base64` for bytes.

A reader rebuilds a request as the same JSON, not the same bytes: only answers are served as they
were recorded.

## Identity

A replay matches each call the agent makes to a recorded one by its kind, its fingerprint and its
occurrence, never by the order calls arrive in. So calls made at once replay in any order.

The fingerprint is the SHA-256, in lowercase hex, of the
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON of an object made from the request:

| Kind | Object | Example |
|---|---|---|
| `api` | `kind`, `method`, `path`, `headers`, `body` and, when it has one, `query` | `{"body":{…},"headers":{"anthropic-version":"2023-06-01"},"kind":"api","method":"POST","path":"/v1/messages"}` |
| `tool` | `kind`, `name` and `args` | `{"args":{"id":"A-17"},"kind":"tool","name":"lookup_order"}` |
| `clock`, `random` | `kind`, `name` and `label` | `{"kind":"clock","label":"start","name":"now"}` |

The project's [normalizers](./normalizers-and-redaction.md) apply first, and under `"clock": "auto"`
(the default) so does masking the dates and timestamps near the run's start. The sections below say
how each part of the object is read.

### The body

`body` is the request body with every `cache_control` member removed, wherever it is: providers
document it as changing nothing.

- **Numbers count as they were sent.** An integer past 2^53 counts by its exact digits, so two ids a
  double rounds alike are two requests. Any other number counts as the double it reads as (`20.0` is
  `20`).
- **A run without `exactNumbers`** may hold numbers JSON.parse rounded. A reader matches it with
  every number read as a double.
- **A multipart body** (a file upload) counts by its parts: each part's name, file name and content
  type, a field's text, and a file's SHA-256.

**Claude Code's session identifier.** A body's `metadata.user_id` that is Claude Code's session
identifier counts as `"<claude-code-session>"`: Claude Code makes a fresh one for every session. It
is a string, either of these:

- the JSON of an object with a `device_id` of hexadecimal digits, an `account_uuid` and a
  `session_id` that is a UUID, as Claude Code sends it;
- `user_<device>_account_<account>_session_<session>`, as earlier versions sent it.

Any other `user_id` counts as sent.

**Gemini's call ids.** In a body with `contents` (Gemini's format, on the Gemini API and Vertex AI),
each `functionCall.id` and `functionResponse.id` counts as `"<call-n>"`. They are numbered in the
order the ids first appear in `contents`. Gemini's answers usually carry no id, so a client that pairs
calls with results by id makes one up, a different one each run, and sends it back in every later
request.

Which result answers which call still counts. A divergence report and Compare show the ids as they
count, so a fork's report names what changed and not the ids.

### The path and the query

`path` is the path the request was sent to under its provider's root, without the query. A Vertex AI
path leaves out its `/projects/<project>/locations/<location>`, which differ from one machine to the
next.

`query` is the request's query parameters as `[name, value]` pairs, decoded, sorted by name, and left
out when there are none. A name sent more than once keeps its values in the order sent.

- **Credentials are never part of it.** A parameter that carries a credential (an API key such as
  Gemini's `key`, a token, a signature, a password) is left out, and so is a value a copy masked as
  `<CREDENTIAL>`.
- **Its values are masked as the body's strings are**: dates near the run's start, and the
  normalizers that have no path.
- **A recording a copy redacted** holds its query with the copy's rules applied, each `name=value` as
  a whole. So a live call's query is read with those rules applied the same way before it is matched.
- **A reader computes it** from the call's `meta.query`.

A recording none of whose calls to a provider kept a `query`, such as one built from a trace, is
matched whatever query a replay's calls to it carry. The replay leaves the query out of their
fingerprints and keeps none on them, so its own replays match the same way.

### Headers

`headers` are the request's fingerprint headers, named in lower case: the few headers that change what
the model does.

An `anthropic` call's `anthropic-beta` counts without the betas that only say how the call signed in,
those starting `oauth-` (a profile's sign-in sends `oauth-2025-04-20`, a key none). It is left out
when nothing else is in it. `fingerprintHeaders` keeps it as it was sent.

The fingerprint headers of each provider:

| Provider | Fingerprint headers |
|---|---|
| `anthropic`, `foundry` | `anthropic-version`, `anthropic-beta` |
| `openai`, `azure` | `openai-beta` |
| `vertex` | `anthropic-beta` |
| `bedrock` | `x-amzn-bedrock-guardrailidentifier`, `x-amzn-bedrock-guardrailversion`, `x-amzn-bedrock-trace`, `x-amzn-bedrock-performanceconfig-latency`, `x-amzn-bedrock-service-tier` |
| `bedrock-mantle` | `openai-beta`, `x-amzn-bedrock-guardrailidentifier`, `x-amzn-bedrock-guardrailversion`, `x-amzn-bedrock-trace`, `x-amzn-bedrock-performanceconfig-latency`, `x-amzn-bedrock-service-tier` |
| `gemini` | none |
| `ai-gateway` | `ai-language-model-id`, `ai-language-model-specification-version`, `ai-language-model-streaming`, `ai-embedding-model-id`, `ai-embedding-model-specification-version` |

A call that went through a host of another's format (`via`) is fingerprinted with the host's headers
above: its format's, and Bedrock's parameters too through `bedrock-mantle`. The part of its path
under the host's root is read as the format's own API names it:

- `/anthropic/v1/messages` through `foundry` as `/v1/messages`;
- `/openai/v1/responses` through `bedrock-mantle` as `/v1/responses`;
- a call under a declared host's `root` so too.

Older recordings are matched without what they never kept:

- **No `anthropic-version`.** A recording none of whose `anthropic` calls names an
  `anthropic-version`, such as one built from a trace (which keeps what was asked, not the headers it
  was sent with), is matched whatever version a replay's requests name. The replay leaves the version
  out of its own calls' fingerprints and `fingerprintHeaders`, so it names none either and holds the
  same calls.
- **No `headerParameters`.** A recording without it, made before calls kept them or imported, is
  matched without the parameters a provider takes as headers beside the body (the `x-amzn-bedrock-`
  headers above), whatever a replay's calls send and whatever its own calls kept. The replay leaves
  them out of its calls' fingerprints and `fingerprintHeaders`, and has no `headerParameters` either,
  so its own replays match the same way.

### A captured call's arguments

A captured call's `args` count as stored, its credentials masked as `<CREDENTIAL>`
([redaction](./normalizers-and-redaction.md#redaction)):

- **A Kubernetes Secret's `data` and `stringData`** are among the credentials masked, in a recording
  an earlier version made that kept one as sent too.
- **A name that names or describes a secret** (`secret_name`, `SecretId`, `password_policy`) is kept
  as sent when its value, or every string in its object or list, reads as no key.

A recording without `secretNames`, made before such names were kept, stored them as `<CREDENTIAL>`
too. One marked `true` stored its path, ref, scope, namespace and id that way. Either is matched with
a replay's calls masked the same way, and the replay stores them so and is marked the same, so its own
replays match the same way.

### The occurrence

The occurrence is *n* for the *n*-th call of the run with the same kind and fingerprint, counted
within the call's scope when the run has scopes.

### Computing fingerprints again

A reader computes the fingerprint of every call and every occurrence again, from the stored request,
unless the run's `normalizersHash` says they were computed under the normalizers in force and the
clock is `exact`. A clock or random read's is computed from its `name` and its request's `label`,
which no normalizer or clock changes.

A producer therefore SHOULD compute them as above, and MUST leave `normalizersHash` out unless it
computed that with the engine's `normalizersHash`.

When Shadowlap changes how a fingerprint is computed, it says so with a version of its own:
`FINGERPRINT_VERSION` is 9. Fingerprints made under another are computed again, so older packs keep
replaying.

## Partial recordings

A recording made by `shadowlap run` holds every call the agent made. One built from what something
else saw holds some kinds of call and not others, and MUST say which in `meta.covers`:

| `meta.covers`                  | The recording holds                    |
|--------------------------------|----------------------------------------|
| `["api"]`                      | Model calls alone                      |
| `["api", "tool:lookup_order"]` | Model calls and every call of one tool |

A replay serves the calls a recording covers from it, as strictly as ever, and runs the rest live,
still blocking writes after a fork.

A recording that leaves `covers` out holds every call the agent makes through Shadowlap, and only
those. A recorded model or tool call the agent never makes is a change too, and its replay
[ends early](./ci.md#a-replay-that-ends-early), which fails a test.

## Reading a pack

A pack is untrusted input: someone else's recording, a golden from a pull request. A reader that
brings one into a store, or runs its command, MUST check it all first, and bring in nothing from a
pack that fails a check:

- `run.json` and every line of `calls.jsonl` parse, and every field has the type, the range and one
  of the values given here. No id, name or label holds a control character; a command's arguments
  may hold tabs and line breaks.
- No time is more than a day ahead of the reader's clock.
- No run appears twice, and no call twice in a run.
- Every blob matches its name, and every blob the calls need is there, request manifests included,
  and each request reads. A blob that git checked out with CRLF line endings is read as it was
  committed when undoing that matches its name, and refused otherwise.
- It keeps to the limits below.

| Limit                 |   Maximum |
|-----------------------|----------:|
| A blob                |   256 MiB |
| All blobs             |     4 GiB |
| `run.json`            |    16 MiB |
| `calls.jsonl`         |     1 GiB |
| Runs                  |    10,000 |
| Calls                 | 1,000,000 |
| A command's arguments |       256 |

A run the store already holds is skipped. It is said to differ when the store's run under that id is
another recording, with another command or other calls.

A run brought in carries a command someone else recorded. A reader marks it (`meta.imported`), and
shows that command and asks before running it.
[SECURITY.md](https://github.com/devjoinedthechat/shadowlap/blob/main/SECURITY.md) lists every check
Shadowlap makes.

## Writing a pack

A pack written from what a framework already knows replays like one `shadowlap pack` wrote. This one
holds a run of an agent that asks Claude about an order, then calls the read tool the model asked
for, `lookup_order`. The run makes no clock or random calls, so it needs no `covers`.

`run.json`:

```json
{
  "format": "shadowlap-pack",
  "version": 1,
  "createdAt": 1790000001000,
  "runs": [
    {
      "runId": "01K5RECQRD1NGF0RMATEXAMP1E",
      "parentRunId": null,
      "mode": "record",
      "status": "completed",
      "divergence": null,
      "command": {
        "argv": [
          "node",
          "agent.mjs"
        ],
        "cwd": "."
      },
      "codeVersion": null,
      "startedAt": 1790000000000,
      "endedAt": 1790000000900,
      "meta": {}
    }
  ]
}
```

`calls.jsonl`, its two lines spread out here:

```json
{
  "runId": "01K5RECQRD1NGF0RMATEXAMP1E",
  "callNo": 1,
  "kind": "api",
  "name": "POST /v1/messages",
  "fingerprint": "9f2cb4ee325fe42c6b9f4ca609c82da02d7f5b0b69f84209adcf4ca3f9025ead",
  "occurrence": 1,
  "origin": "live",
  "effect": null,
  "requestRef": "54936b29981c8437f02033c7af19ae2483f7a77f86226c7c58515ff22d0f4b90",
  "meta": {
    "provider": "anthropic",
    "fingerprintHeaders": {
      "anthropic-version": "2023-06-01"
    }
  },
  "at": 1790000000100,
  "end": {
    "runId": "01K5RECQRD1NGF0RMATEXAMP1E",
    "callNo": 1,
    "attempt": 0,
    "responseRef": "08f644b5cf60fc86d18f39e180c97e2829188d69d0c10758f9a46d04d845640c",
    "outcome": "ok",
    "meta": {
      "status": 200,
      "headers": {
        "content-type": "application/json"
      },
      "model": "claude-haiku-4-5",
      "usage": {
        "inputTokens": 61,
        "outputTokens": 18
      }
    },
    "at": 1790000000700
  },
  "attempts": []
}
```

```json
{
  "runId": "01K5RECQRD1NGF0RMATEXAMP1E",
  "callNo": 2,
  "kind": "tool",
  "name": "lookup_order",
  "fingerprint": "9b7bfb487df5fd079698afe0fca39bf1ea5cf27d11e2227de63e95920c23f99e",
  "occurrence": 1,
  "origin": "live",
  "effect": "read",
  "requestRef": "73f18a0574ce5379b6c597d332f5d6f454f207471436997f965f75f4b8e15e98",
  "meta": {},
  "at": 1790000000710,
  "end": {
    "runId": "01K5RECQRD1NGF0RMATEXAMP1E",
    "callNo": 2,
    "attempt": 0,
    "responseRef": "6a4a67a37ba3f6710e4e5215dd094b20395a2ba58d1e1831dacb862028b0502e",
    "outcome": "ok",
    "meta": {
      "latencyMs": 40
    },
    "at": 1790000000750
  },
  "attempts": []
}
```

`blobs/`, each file named and then its bytes. Call 1's request manifest, and the three parts it names:
the system prompt, the tools and the one message.

```text
blobs/54936b29981c8437f02033c7af19ae2483f7a77f86226c7c58515ff22d0f4b90
{
  "v": 1,
  "kind": "chunked",
  "fields": {
    "model": "claude-haiku-4-5",
    "max_tokens": 256
  },
  "system": "080ee1958b9d3873e1975beff06be3077b8898465ac1760d94917972f077ad82",
  "tools": "d8baf8aeda22555028c0da9d87199a6d08f7409ff9443bb7ed35771ca250d1f1",
  "messages": [
    "6a2997d05bccf706a77bbc3d6f611a64024a9446f175c18c214cb5659c2673b1"
  ]
}
```

```text
blobs/080ee1958b9d3873e1975beff06be3077b8898465ac1760d94917972f077ad82
"You look orders up."
```

```text
blobs/d8baf8aeda22555028c0da9d87199a6d08f7409ff9443bb7ed35771ca250d1f1
[{"name":"lookup_order","input_schema":{"type":"object"}}]
```

```text
blobs/6a2997d05bccf706a77bbc3d6f611a64024a9446f175c18c214cb5659c2673b1
{"role":"user","content":"What did order A-17 cost?"}
```

What the model answered, as Anthropic's API sent it:

```text
blobs/08f644b5cf60fc86d18f39e180c97e2829188d69d0c10758f9a46d04d845640c
{
  "id": "msg_01",
  "type": "message",
  "role": "assistant",
  "model": "claude-haiku-4-5",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_01",
      "name": "lookup_order",
      "input": {
        "id": "A-17"
      }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 61,
    "output_tokens": 18
  }
}
```

The tool call's arguments, and what it returned:

```text
blobs/73f18a0574ce5379b6c597d332f5d6f454f207471436997f965f75f4b8e15e98
{"args":{"id":"A-17"}}
```

```text
blobs/6a4a67a37ba3f6710e4e5215dd094b20395a2ba58d1e1831dacb862028b0502e
{"result":{"id":"A-17","total":180}}
```

And `.gitattributes`, `* -text`.

Call 2's fingerprint is the SHA-256 of `{"args":{"id":"A-17"},"kind":"tool","name":"lookup_order"}`.
Call 1's is the SHA-256 of this object, written with no whitespace at all:

```json
{
  "body": {
    "max_tokens": 256,
    "messages": [
      {
        "content": "What did order A-17 cost?",
        "role": "user"
      }
    ],
    "model": "claude-haiku-4-5",
    "system": "You look orders up.",
    "tools": [
      {
        "input_schema": {
          "type": "object"
        },
        "name": "lookup_order"
      }
    ]
  },
  "headers": {
    "anthropic-version": "2023-06-01"
  },
  "kind": "api",
  "method": "POST",
  "path": "/v1/messages"
}
```

### Check it

Check a pack you wrote with [`shadowlap test`](./cli.md#test). It brings the pack in as a reader
must, runs its command with every provider offline, and passes only when the agent sent every
recorded request unchanged, and no other.

Its command came from your producer, not from a recording made here. So until your repository tracks
the pack, `test` asks before it runs it; `--yes` says yes:

```sh
shadowlap test refund-flow --yes
```

It prints:

```text
✓ refund-flow: 2/2 replayed, 61 input tokens not re-spent

1 passed, 0 failed · 0 upstream requests
```

## Recording through Shadowlap

A producer can leave the files to Shadowlap too:

- **`shadowlap run -- <command>`** records any agent, and `shadowlap pack <run> <dir>` writes its pack
  with the project's redaction rules applied ([CI](./ci.md#make-a-golden)).
- **An SDK for a language Shadowlap doesn't ship** records tool calls, clock reads and random values
  through [the wire protocol](./protocol.md). Model calls need nothing, as the provider's own SDK is
  pointed at Shadowlap.
- **A test runner** records each test through the recordings protocol, below, which writes the test's
  pack when it passes and replays it offline after.

## The recordings protocol

Shadowlap's pytest, Vitest, Jest and node:test integrations are clients of one small HTTP API on
`shadowlap serve --recordings`. It is specified here so that an integration can be written for a test
runner Shadowlap doesn't ship: JUnit, Go's `testing`, RSpec, Playwright, anything that can spawn a
process and make an HTTP request.

A [recorded test](./testing.md) records its agent's calls the first time it runs, as a pack beside the
test, and replays them offline afterwards: fast, free and deterministic, failing with a diff when a
code change alters a request.

It is a different API from [the SDK wire protocol](./protocol.md), and a full integration needs both.
This one decides *which recording a test uses and what happens to it*, while the wire protocol carries
the individual tool, clock and randomness calls.

### The handshake

The host is started by the plugin, once per test-runner **worker process**, and lives as long as that
process does.

1. Spawn `shadowlap serve --recordings` with the project root as its working directory, and with
   **stdout and stdin both piped**.
2. Read **one line** of JSON from its stdout:

   ```json
   {
     "shadowlap": "0.1.0",
     "url": "http://127.0.0.1:53211/t/9f2c…",
     "root": "/path/to/project",
     "env": {
       "ANTHROPIC_BASE_URL": "http://127.0.0.1:53211/t/9f2c…/s/__SLOT__/anthropic",
       "SHADOWLAP_CAPTURE": "…"
     },
     "capture": { "node": "/…/guard/node-capture.mjs", "python": "/…/guard" }
   }
   ```

3. In every value of `env`, replace the literal `__SLOT__` with this worker's [slot](#slots). Then set
   those variables in the test process **before** any model SDK or capture module loads. These are
   what point the provider SDKs at the host.
4. Load the capture module for your language from `capture`: `capture.node` is a file to `--import`,
   `capture.python` a directory to put on `sys.path` before importing `_shadowlap_capture`. It patches
   clients that can't be redirected by a base URL. Skip this and `fetch`/`httpx`-level calls and
   signed clients (Bedrock, Vertex, Azure) go unrecorded.
5. **Keep stdin open.** The host runs until its stdin closes, which is how it shuts down when the
   runner exits. Closing stdin (or `SIGINT`/`SIGTERM`) is the only stop signal; there is no endpoint
   for it.

The handshake line's fields:

| Field       | Type   | Meaning                                                                            |
|-------------|--------|------------------------------------------------------------------------------------|
| `shadowlap` | string | The CLI's version, for an integration to report alongside its own                  |
| `url`       | string | The host's base URL, with a session token as a path segment                        |
| `root`      | string | The project root                                                                   |
| `env`       | object | The variables that point the provider SDKs at the host, with `__SLOT__` to replace |
| `capture`   | object | The capture module for each language: `node` and `python`                          |

Treat `url` as opaque: it carries a session token as a path segment, and it is a credential, so don't
log it.

**Tests without a recording.** A call that reaches a slot no recording holds is refused with `409`. So
a runner whose tests don't all have a recording sets the variables only from `start` to `end`, and
then puts back what they were. It turns capture off in between, as the pytest and Vitest plugins do:

- in Python, the module's `active = False`;
- in Node, `globalThis[Symbol.for('shadowlap.capture')].active = false`.

Capture reads its configuration when it loads, so load it with the variables set.

### Slots

A slot is a short name for one parallel worker, so that several workers share one host without taking
each other's runs.

- **Derive it** from the runner's worker id (pytest-xdist's `PYTEST_XDIST_WORKER`, a Vitest worker
  index), falling back to `main` when the runner is single-process.
- **Keep it** to letters, digits, `_`, `.` and `-`, at most 64 characters.

The same slot goes in the `__SLOT__` substitution and in the `slot` field of `start`.

### Endpoints

Every request is `POST` with a JSON body and `content-type: application/json`, to `url` followed by
the endpoint's path:

| Endpoint                    | When to call it                                       | Answers |
|-----------------------------|-------------------------------------------------------|---------|
| `POST /v1/recordings/start` | When a test starts, before the agent runs             | `201`   |
| `POST /v1/recordings/calls` | Optional: any time while the run is in progress       | `200`   |
| `POST /v1/recordings/end`   | Exactly once per `start`, whatever the test's outcome | `200`   |

On a response that isn't a 2xx, the body is
`{"type": "error", "error": {"type": "shadowlap_error", "message": "…"}}`, and `error.message` is the
one to show.

#### `POST /v1/recordings/start`

Call it when a test starts, before the agent runs.

```json
{ "recording": "tests/recordings/refund-flow", "slot": "gw0", "mode": "missing", "name": "test_refund_flow", "command": ["pytest", "-k", "refund"] }
```

| Field | Type | Meaning |
|---|---|---|
| `recording` | string | The recording's directory, a pack. Absolute, or relative to the project root. It MUST resolve inside the root; anything else is a 400 |
| `slot` | string | This worker's slot |
| `mode` | string, optional | `missing` (the default), `all` or `none` |
| `name` | string, optional | The test's name, used in the run's command line when none is given |
| `command` | array of strings, optional | The command to record as the run's own, for `shadowlap replay` later |

What each `mode` does:

| `mode`    | What it does                                                        |
|-----------|---------------------------------------------------------------------|
| `missing` | Replay when a recording exists, record when it doesn't. The default |
| `all`     | Always record                                                       |
| `none`    | Only replay, and fail when there is nothing to replay               |

**`command`.** Whoever holds the session token chose it, so the run is marked as a pack's is:
replaying it asks before running that command, unless `--yes` is given or yours follows `--`.
Without one, the run records `<test>` and the test's name, and has no command to run again. Replaying
it, finding its commit or forking it needs yours after `--`, as for a capture.

It answers `201`:

```json
{ "runId": "01K5CQ4N7G…", "mode": "record", "recording": "tests/recordings/refund-flow" }
```

| Field | Type | Meaning |
|---|---|---|
| `runId` | string | The run the test's calls are recorded or replayed in |
| `mode` | string | What actually happened, `record` or `replay`: what the test should report |
| `recording` | string | The recording's directory |
| `placeholders` | object, optional | A replay's [placeholder keys](./how-it-works.md#keys), such as `{ "OPENAI_API_KEY": "shadowlap-offline-replay-placeholder" }` |

**Placeholders** are the keys for the providers the recording called whose credentials the host's
environment lacks. Set each in the test's process while the test runs, only where the variable is
unset or empty, and put it back as it was when the test ends. Then a model client the test builds the
default way sends what the recording answers. The replay is offline: no placeholder goes anywhere.

It refuses a start with these statuses:

| Status | Meaning |
|---|---|
| 400 | `recording` doesn't resolve inside the project root |
| 404 | A `none` mode with no recording on disk; the message says how to record it |
| 409 | The local store already holds the recording's run as another recording, with other calls; the message says how to replay this one |
| 422 | The recording holds no runs |

Starting a run in a slot ends whatever was still running in that slot, so a crashed test doesn't
wedge the worker.

#### `POST /v1/recordings/calls`

Optional, and what makes assertions possible. Call it any time while the run is in progress, as often
as you like:

```json
{ "runId": "01K5CQ4N7G…" }
```

It answers with the calls so far:

```json
{
  "answer": "Refunded order 1182.",
  "calls": [
    { "callNo": 1, "kind": "api", "name": "POST /v1/messages", "origin": "replayed", "outcome": "ok", "model": "claude-haiku-4-5" },
    { "callNo": 2, "kind": "tool", "name": "send_email", "origin": "blocked", "outcome": "error", "args": { "to": "x@y" }, "error": { "name": "ShadowlapWriteBlocked", "message": "…" } }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `answer` | string or `null` | The text of the last model response, or `null` before there is one |
| `calls` | array | Each call's `callNo`, `kind`, `name`, `origin` and `outcome`, and the fields below |
| `calls[].outcome` | string or `null` | `ok` or `error`; `null` while a call is still in flight |
| `calls[].model` | string, optional | The model of a model call |
| `calls[].args`, `result`, `error` | JSON, optional | For tool calls only, exactly as the agent saw them |
| `calls[].scope` | string, optional | When the call was made inside one |

Expose these to the test: "`send_email` was never called" is the assertion people actually want.

#### `POST /v1/recordings/end`

Call it exactly once per `start`, whatever the test's outcome:

```json
{ "runId": "01K5CQ4N7G…", "passed": true }
```

`passed` is the test's own result, and it decides what happens next:

| Mode | `passed` | What the host does |
|---|---|---|
| record | `true` | Packs the run into the recording directory, atomically, with the redaction rules from `shadowlap.config.json` applied |
| record | `false` | Saves nothing: a failing test shouldn't become the golden |
| record | `true`, no calls | Saves nothing, and says so: usually a base URL that was never redirected |
| replay | either | Deletes a clean replay, since it adds nothing. Keeps a divergence, or a replay that ended early, in the local store to inspect |

- **Atomically** means written beside it and swapped in, so an interrupted write never leaves half a
  pack.
- **A replay that ended early**: every request the test sent matched, but it stopped before making
  every recorded model or tool call. It fails with
  `ended early at call 13 (api POST /v1/messages): 12 of 30 recorded calls replayed`.

It answers with the verdict:

```json
{
  "ok": false,
  "mode": "replay",
  "runId": "01K5CQ4N7G…",
  "recording": "tests/recordings/refund-flow",
  "calls": 30,
  "replayed": 12,
  "message": "diverged from its recording at call 13 (api POST /v1/messages)",
  "report": "…the divergence report and run summary, ready to print…"
}
```

| Field       | Type              | Meaning                                          |
|-------------|-------------------|--------------------------------------------------|
| `ok`        | boolean           | The verdict the test should fail on              |
| `mode`      | string            | `record` or `replay`                             |
| `runId`     | string            | The test's run                                   |
| `recording` | string            | The recording's directory                        |
| `calls`     | integer           | How many calls the run made                      |
| `replayed`  | integer           | How many of them were served from the recording  |
| `message`   | string or `null`  | One line for a test-runner summary               |
| `report`    | string or `null`  | The multi-line diff and summary to print in full |
| `saved`     | boolean, optional | On a record: whether the pack was written        |

**`ok` is the verdict the test should fail on.** On a record that saved, `saved` is `true` and
`message` and `report` are both `null`.

### Choosing the mode

The default that makes recorded tests pleasant picks the mode from the environment:

| Environment            | Mode              |
|------------------------|-------------------|
| `SHADOWLAP_RECORD` set | The mode it names |
| `CI` set               | `none`            |
| Neither                | `missing`         |

So a developer's first run records, later runs replay, and CI never records: a missing recording fails
the build instead of quietly making one.

### Checklist for a new integration

1. Spawn the host once per worker; read its JSON line; substitute `__SLOT__`; set the env before anything else loads.
2. Load the capture module for your language.
3. Keep stdin open for the life of the worker.
4. `start` per test, with the recording directory and the slot; set the `placeholders` a replay comes with where their variables are empty, until the test ends.
5. `end` per test with the real `passed`, exactly once, even when the test errored.
6. Fail the test when `ok` is false, printing `report`.
7. Expose `calls` and `answer` to the test for assertions.
8. Pick the mode from the environment, defaulting to `none` under CI.

## Versions

This page is version 1, for packs and the protocol alike. Each says its version where a reader looks
first:

- **A pack** says its version in `run.json`'s `version`, and a reader refuses a version it doesn't
  know. A change that would make a pack mean something else to a reader that doesn't know it, or keep
  a reader from reading it, comes with another version.
- **A [request manifest](#request-manifests)** says its own version in `v`. So another way to store a
  request comes as another manifest version, which a reader that doesn't know it refuses, naming the
  request, as it refuses a pack of a version it doesn't know.
- **The protocol** says its version in its routes, `/v1/recordings/…`. A change that would break an
  integration written to this page comes with routes under another version. `shadowlap` in the
  handshake is the CLI's version, for an integration to report alongside its own.

What a reader or an integration can ignore comes without another version:

- a key added under a run's or a call's `meta`;
- a provider added, whose calls keep the fingerprints they were written with in a reader that doesn't
  know it;
- a field added to a response.

Shadowlap is pre-1.0, and of everything it has, the format is what changes least: build on it where
you have the choice.

## See also

- [The engine as a library](./engine.md): `packRun`, `unpackRun` and the fingerprint functions.
- [The wire protocol](./protocol.md): how an SDK records tool, clock and random calls.
- [Recorded tests](./testing.md): the shipped integrations of the recordings protocol.
- [CI](./ci.md): goldens, and a replay that ends early.
