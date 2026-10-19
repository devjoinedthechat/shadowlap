# The recording format

Version 1. Shadowlap is the reference implementation.

A recording is everything an agent run said to the world and heard back: each model call's request and response, each tool call's arguments and result, each clock read and random value, numbered in the order the run made them. Shadowlap replays an agent's real code against one, serving every call that hasn't changed from it. This page specifies the form a recording takes outside a store, a *pack*: a folder of plain files that can be committed as a [golden](./ci.md), attached to an issue or shared. A framework, a tracing tool or a test runner that writes packs gets recordings Shadowlap replays, and one that reads them gets every run Shadowlap records.

> **Normative language.** MUST, SHOULD and MAY carry their usual weight. The reference implementation is `@shadowlap/engine`: `packRun` writes a pack, `unpackRun` reads one, `validateRun` and `validateCall` check its records, and `fingerprintApi`, `fingerprintTool` and `fingerprintMisc` compute identities ([the engine as a library](./engine.md)). Where this page and the engine disagree, the engine is what replays: [open an issue](https://github.com/devjoinedthechat/shadowlap/issues).

## A pack

```
refund-flow/
├── run.json          the runs
├── calls.jsonl       every call, one JSON object per line
├── blobs/            every request and response, one file each, named by its SHA-256
└── .gitattributes    * -text
```

- A pack MUST have `run.json`. `calls.jsonl` and `blobs/` MAY be left out of a pack whose runs made no calls.
- Every file in it MUST be a regular file. A reader refuses a symbolic link, and a name in `blobs/` that isn't a SHA-256.
- Anything else in the folder, such as a README, is not part of the pack: a reader ignores it, and a writer that replaces a pack (the same golden packed again) leaves it.
- `.gitattributes` holds `* -text`, so that git never converts a pack's line endings: a blob that no longer matches its name is refused. A writer SHOULD add it unless the folder has one.

## run.json

```json
{
  "format": "shadowlap-pack",
  "version": 1,
  "createdAt": 1790000001000,
  "runs": []
}
```

| Field | |
|---|---|
| `format` | `"shadowlap-pack"` |
| `version` | `1`, this page. A reader MUST refuse a version it doesn't know |
| `createdAt` | When the pack was written, in milliseconds since the epoch, as every time here is |
| `runs` | 1 to 10,000 runs: the run packed, last, and before it any runs it was replayed from, root first |

### A run

| Field | Required | |
|---|---|---|
| `runId` | yes | A ULID: 26 characters of Crockford base32 (`0-9`, `A-Z` without `I`, `L`, `O` and `U`) |
| `parentRunId` | no | The run it replayed, or `null` for a recording. It may name a run the pack doesn't hold |
| `mode` | yes | `record` or `replay` |
| `status` | yes | `running`, `completed`, `failed` or `crashed`. A reader takes `running` as `crashed`: nothing records the run any more |
| `command` | yes | `{ "argv": […], "cwd": "…" }`: the command that started the agent, 1 to 256 arguments, and where it ran |
| `codeVersion` | no | The git revision the run was made at, up to 128 characters, or `null` |
| `startedAt` | yes | When the run started |
| `endedAt` | no | When it ended, or `null` |
| `divergence` | no | Where a replay forked, or `null`: its `type` (`request_changed`, `new_call`, `forced`, `beyond_recording` or `ended_early`), `callNo`, `kind`, `name` and the calls `replayedBefore` it |
| `meta` | no | An object of the keys below and any others: a reader MUST keep keys it doesn't know |

A run made where nothing knows what started the agent, such as a capture of production traffic, has `["<no-recorded-command>"]` as its `argv`: replaying it then takes the agent's command after `--`.

| `meta` key | |
|---|---|
| `labels` | Up to 50 labels, each 1 to 40 letters, digits, spaces and `_ . : / -`, starting with a letter or a digit |
| `notes` | Up to 1,000 notes, `{ "callNo": …, "text": "…", "at": … }`, with `callNo` `null` for a note on the run |
| `redactions` | The [redaction rules](./normalizers-and-redaction.md#redaction) applied to the pack's copy of the run. A replay applies them as normalizers, so a live request matches the masked recording |
| `covers` | What a [partial recording](#partial-recordings) holds |
| `inputs` | `true`: what a person typed during the run is recorded, as `user_input` tool calls ([the wire protocol](./protocol.md#user-input)) |
| `normalizersHash` | Under what the stored fingerprints were computed ([identity](#identity)). A producer leaves it out |
| `imported` | Written by a reader that brings the run into a store: where it came from. A pack's own is replaced |

Shadowlap keeps more under `meta` (what a blame found, how a test judged the run, what a replay changed); a producer leaves those out.

## calls.jsonl

One call per line, each a JSON object:

| Field | Required | |
|---|---|---|
| `runId` | yes | A run in `run.json` |
| `callNo` | yes | 1, 2, 3… in the order the run made its calls; once per run |
| `kind` | yes | `api`, `tool`, `clock` or `random` |
| `name` | yes | Up to 512 characters. `api`: the method and the path, `POST /v1/messages`; `tool`: the tool's name; `clock`: `now`; `random`: `random` or `uuid` |
| `fingerprint` | yes | The call's identity, 64 lowercase hex digits ([identity](#identity)) |
| `occurrence` | yes | 1 for the first call with that fingerprint, 2 for the second… |
| `origin` | yes | What happened to the call in this run: `live`, `replayed`, `blocked`, `stubbed` or `overridden`. Every call of a recording is `live` |
| `effect` | no | `pure`, `read` or `write` for a tool; `null` for every other kind |
| `requestRef` | no | The blob holding the request, or `null` |
| `meta` | no | An object of the keys below and any others, which a reader keeps |
| `at` | yes | When the call started |
| `end` | no | How it ended, or `null` for a call the run never finished |
| `attempts` | yes | Earlier ends of a call that was tried again, as an SDK retries a 429, first to last; `[]` otherwise |

An end, in `end` and in `attempts`:

| Field | |
|---|---|
| `runId`, `callNo` | The call's |
| `attempt` | 0 for the first, 1 for the next… |
| `responseRef` | The blob holding the answer, or `null` |
| `outcome` | `ok` or `error` |
| `meta` | An object |
| `at` | When it ended |

| Call `meta` key | Where | |
|---|---|---|
| `provider` | start, `api` | The API the request was for: `anthropic`, `openai`, `gemini`, `bedrock`, `vertex` or `azure`. A reader needs it to compute the call's fingerprint again |
| `fingerprintHeaders` | start, `api` | The request's [fingerprint headers](#identity) as it sent them, names in lower case |
| `scope` | start | The branch of the agent the call was made in ([scopes](./sdk.md#scopes)) |
| `implHash` | start, `tool` | A hash of the tool's source, for the warning that it changed since the recording |
| `status`, `headers` | end, `api` | The response's HTTP status (200 when left out) and headers, served with its body on replay: `content-type` tells the client a stream (`text/event-stream`) from JSON |
| `chunks` | end, `api` | A stream's events as `[byteOffset, msSinceFirstByte]` pairs, to play it back at its recorded pace |
| `retryable` | end, `api` | The failure was one a client retries (429, 5xx) |
| `model`, `usage`, `stopReason` | end, `api` | The model that answered, `{ "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens" }` and why it stopped: for costs and reports |
| `latencyMs` | end | How long the call took |
| `error` | end | A failed call's error, `{ "name", "message", "code", "data" }`, the last two optional |

## Blobs

Every request and every answer is a blob: a file in `blobs/` whose name is the SHA-256 of its bytes, in lowercase hex, stored uncompressed.

- A reader MUST refuse a blob whose bytes don't hash to its name.
- Every blob a call names, and every blob a request manifest names, MUST be in the pack.
- A JSON blob is UTF-8. Its numbers are kept as written, so an id past 2^53 stays exact.

| Kind | The request, at `requestRef` | The answer, at `end.responseRef` |
|---|---|---|
| `api` | A [request manifest](#request-manifests) | The response body as it was received, byte for byte: JSON, or a stream's events |
| `tool` | `{"args": …}`, the arguments | `{"result": …}`, what the tool returned, or `{"error": …}`, what it raised |
| `clock` | `{"label": "…"}` | `{"result": …}`, milliseconds since the epoch |
| `random` | `{"label": "…"}` | `{"result": …}`: a number from 0 up to 1 for `random`, a UUID for `uuid` |

A call to a host [declared under `http`](./sdk.md#http-services-without-wrapping) is a `tool` call with `meta.http` naming the host. Its arguments are `{"method", "url", "body", "encoding"}` and its result `{"status", "headers", "body", "encoding"}`, `encoding` being `json`, `text` or `base64` and the body left out when there is none.

### Request manifests

A model request resends the whole conversation, so its parts are stored apart, and every part a run's calls share is stored once. A request body that is a JSON object with a `messages` array is *chunked*:

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

- `system`, `tools` and each of `messages` name a JSON blob that holds that member of the body; `system` and `tools` are `null` when the body has none.
- `fields` holds every other member of the body.

Any other body is *whole*: `{ "v": 1, "kind": "whole", "blob": "…", "encoding": "json" }`, where the blob holds the body and `encoding` says how to read it: `json`, `utf8`, or `base64` for bytes. A reader rebuilds a request as the same JSON, not the same bytes: only answers are served as they were recorded.

## Identity

A replay matches each call the agent makes to a recorded one by its kind, its fingerprint and its occurrence, never by the order calls arrive in, so calls made at once replay in any order.

The fingerprint is the SHA-256, in lowercase hex, of the [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON of an object made from the request:

| Kind | Object | Example |
|---|---|---|
| `api` | `kind`, `method`, `path`, `headers` and `body` | `{"body":{…},"headers":{"anthropic-version":"2023-06-01"},"kind":"api","method":"POST","path":"/v1/messages"}` |
| `tool` | `kind`, `name` and `args` | `{"args":{"id":"A-17"},"kind":"tool","name":"lookup_order"}` |
| `clock`, `random` | `kind` and `label` | `{"kind":"clock","label":"start"}` |

- `body` is the request body with every `cache_control` member removed, wherever it is: providers document it as changing nothing. A multipart body (a file upload) counts by its parts: each part's name, file name and content type, a field's text, and a file's SHA-256.
- `path` is the path the request was sent to under its provider's root, without the query. A Vertex AI path leaves out its `/projects/<project>/locations/<location>`, which differ from one machine to the next.
- `headers` are the request's fingerprint headers, named in lower case: the few headers that change what the model does.
- The project's [normalizers](./normalizers-and-redaction.md) apply first, and under `"clock": "auto"` (the default) so does masking the dates and timestamps near the run's start.

| Provider | Fingerprint headers |
|---|---|
| `anthropic` | `anthropic-version`, `anthropic-beta` |
| `openai`, `azure` | `openai-beta` |
| `vertex` | `anthropic-beta` |
| `gemini`, `bedrock` | none |

The occurrence is *n* for the *n*-th call of the run with the same kind and fingerprint, counted within the call's scope when the run has scopes.

A reader computes the fingerprint of every `api` and `tool` call and every occurrence again, from the stored request, unless the run's `normalizersHash` says they were computed under the normalizers in force and the clock is `exact`. A producer therefore SHOULD compute them as above, and MUST leave `normalizersHash` out unless it computed that with the engine's `normalizersHash`. Clock and random fingerprints are never computed again: a producer MUST compute those exactly. When Shadowlap changes how a fingerprint is computed, it says so with a version of its own (`FINGERPRINT_VERSION`, now 4), and fingerprints made under another are computed again, so older packs keep replaying.

## Partial recordings

A recording made by `shadowlap run` holds every call the agent made. One built from what something else saw holds some kinds of call and not others, and MUST say which in `meta.covers`: `["api"]` for model calls alone, `["api", "tool:lookup_order"]` for model calls and every call of one tool. A replay serves the calls a recording covers from it, as strictly as ever, and runs the rest live, still blocking writes after a fork.

A recording that leaves `covers` out holds every call the agent makes through Shadowlap, and only those: a recorded model or tool call the agent never makes is a change too, and its replay [ends early](./ci.md#a-replay-that-ends-early), which fails a test.

## Reading a pack

A pack is untrusted input: someone else's recording, a golden from a pull request. A reader that brings one into a store, or runs its command, MUST check it all first and bring in nothing from a pack that fails a check:

- `run.json` and every line of `calls.jsonl` parse, and every field has the type, the range and one of the values given here. No id, name or label holds a control character; a command's arguments may hold tabs and line breaks.
- No time is more than a day ahead of the reader's clock.
- No run appears twice, and no call twice in a run.
- Every blob matches its name, and every blob the calls need is there, request manifests included, and each request reads. A blob that git checked out with CRLF line endings is read as it was committed when undoing that matches its name, and refused otherwise.
- It keeps to these limits:

| Limit | |
|---|---|
| A blob | 256 MiB |
| All blobs | 4 GiB |
| `run.json` | 16 MiB |
| `calls.jsonl` | 1 GiB |
| Runs | 10,000 |
| Calls | 1,000,000 |
| A command's arguments | 256 |

A run the store already holds is skipped, and said to differ when the store's run under that id is another recording, with another command or other calls. A run brought in carries a command someone else recorded: a reader marks it (`meta.imported`), and shows that command and asks before running it. [SECURITY.md](https://github.com/devjoinedthechat/shadowlap/blob/main/SECURITY.md) lists every check Shadowlap makes.

## Writing a pack

A pack written from what a framework already knows replays like one `shadowlap pack` wrote. This one holds a run of an agent that asks Claude about an order, then calls the read tool the model asked for, `lookup_order`. The run makes no clock or random calls, so it needs no `covers`.

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

`blobs/`, each file named and then its bytes. Call 1's request manifest, and the three parts it names: the system prompt, the tools and the one message.

```
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

```
blobs/080ee1958b9d3873e1975beff06be3077b8898465ac1760d94917972f077ad82
"You look orders up."
```

```
blobs/d8baf8aeda22555028c0da9d87199a6d08f7409ff9443bb7ed35771ca250d1f1
[{"name":"lookup_order","input_schema":{"type":"object"}}]
```

```
blobs/6a2997d05bccf706a77bbc3d6f611a64024a9446f175c18c214cb5659c2673b1
{"role":"user","content":"What did order A-17 cost?"}
```

What the model answered, as Anthropic's API sent it:

```
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

```
blobs/73f18a0574ce5379b6c597d332f5d6f454f207471436997f965f75f4b8e15e98
{"args":{"id":"A-17"}}
```

```
blobs/6a4a67a37ba3f6710e4e5215dd094b20395a2ba58d1e1831dacb862028b0502e
{"result":{"id":"A-17","total":180}}
```

And `.gitattributes`, `* -text`.

Call 2's fingerprint is the SHA-256 of `{"args":{"id":"A-17"},"kind":"tool","name":"lookup_order"}`. Call 1's is the SHA-256 of this object, written with no whitespace at all:

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

Check a pack you wrote with [`shadowlap test`](./cli.md#test): it brings the pack in as a reader must, runs its command with every provider offline, and passes only when the agent sent every recorded request unchanged, and no other:

```sh
shadowlap test refund-flow
```

```
✓ refund-flow: 2/2 replayed, 61 input tokens not re-spent

1 passed, 0 failed · 0 upstream requests
```

## Recording through Shadowlap

A producer can leave the files to Shadowlap too:

- `shadowlap run -- <command>` records any agent, and `shadowlap pack <run> <dir>` writes its pack with the project's redaction rules applied ([CI](./ci.md#make-a-golden)).
- An SDK for a language Shadowlap doesn't ship records tool calls, clock reads and random values through [the wire protocol](./protocol.md); model calls need nothing, as the provider's own SDK is pointed at Shadowlap.
- A test runner records each test through [the recordings protocol](./recordings-protocol.md), which writes the test's pack when it passes.

## Versions

- `version` is 1. A change that would make a pack mean something else to a reader that doesn't know it, or keep a reader from reading it, comes with a new version, and a reader refuses a version it doesn't know.
- What a reader can ignore comes without one: a new key under a run's or a call's `meta`, or a new provider, whose calls keep the fingerprints they were written with in a reader that doesn't know it.
- Shadowlap is pre-1.0, and of everything it has, the format is what changes least: build on it where you have the choice.
