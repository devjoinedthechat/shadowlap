# Providers

shadowlap records the model calls of every provider below into the same run, so an agent that calls
Anthropic for planning and Bedrock for tools gets one timeline. This page covers how each provider's
calls reach the sidecar, what a replay needs, and how to send a provider's calls elsewhere.

The proxy is body-agnostic: a provider module only says which hosts it owns, which headers matter,
how retries are marked and how to read token usage.

## Supported providers

The notes say how each provider's calls reach the sidecar: through a base-URL variable
`shadowlap run` sets, or by [in-process capture](#in-process-capture).

| Provider | Wire format | Notes |
|---|---|---|
| Anthropic | Anthropic | `ANTHROPIC_BASE_URL` |
| OpenAI and OpenAI-compatible | OpenAI | `OPENAI_BASE_URL` (with `/v1`) |
| Google Gemini | Gemini | `GOOGLE_GEMINI_BASE_URL` |
| Azure OpenAI | OpenAI | In-process capture |
| Gemini Enterprise Agent Platform (Vertex AI), Claude and Gemini models | Anthropic for Claude, Gemini for Gemini | In-process capture |
| Amazon Bedrock (InvokeModel and Converse, streamed or not) | Bedrock's InvokeModel and Converse | In-process capture |
| Claude on Microsoft Foundry (`AnthropicFoundry`) | Anthropic | In-process capture, recorded as Anthropic's |
| OpenAI's SDK on Amazon Bedrock (`bedrock-mantle`) | OpenAI | In-process capture, recorded as OpenAI's |
| A host the config declares (`providers`) | The format it names | In-process capture, recorded as the format it names |
| Vercel's AI Gateway (`ai-gateway`) | The AI SDK's own | In-process capture; the AI SDK sends a model named by a string here |

### Headers

Fingerprinted headers are part of what a call is [matched by](./how-it-works.md#calls-and-identity).
Headers that are never stored stay out of the recording.

| Provider | Fingerprinted headers | Never stored |
|---|---|---|
| Anthropic | `anthropic-version`, `anthropic-beta` but for the `oauth-` betas a profile's sign-in adds | `x-api-key`, `authorization`, cookies, the `anthropic-organization-id` an answer names |
| OpenAI and OpenAI-compatible | `openai-beta` | `authorization`, `openai-organization`, `openai-project`, cookies |
| Google Gemini | none | `x-goog-api-key`, `authorization`, the `?key=` query string |
| Azure OpenAI | `openai-beta` | `api-key`, `authorization`, `openai-organization`, `openai-project`, cookies |
| Vertex AI | `anthropic-beta` | `authorization`, `x-goog-api-key`, `x-goog-user-project`, cookies |
| Amazon Bedrock | What InvokeModel takes as headers: `x-amzn-bedrock-guardrailidentifier`, `x-amzn-bedrock-guardrailversion`, `x-amzn-bedrock-trace`, `x-amzn-bedrock-performanceconfig-latency`, `x-amzn-bedrock-service-tier` | `authorization`, `x-amz-security-token`, `x-amz-date`, `x-amz-content-sha256`, `x-amzn-trace-id`, cookies |
| Claude on Microsoft Foundry | `anthropic-version`, `anthropic-beta` | `x-api-key`, `api-key`, `authorization`, cookies, `anthropic-organization-id` |
| OpenAI's SDK on Amazon Bedrock | `openai-beta`, and the Bedrock headers above | `authorization`, `x-amz-security-token`, `x-amz-date`, `x-amz-content-sha256`, `x-amzn-trace-id`, cookies |
| A host the config declares | The format's | The format's, `x-api-key` and `api-key` |
| Vercel's AI Gateway | The model, the spec version and streaming: `ai-language-model-id`, `ai-language-model-specification-version`, `ai-language-model-streaming` (and the `ai-embedding-model-` ones) | `authorization`, `ai-gateway-auth-method`, cookies |

## In-process capture

A base URL can't reach every client:

- Bedrock clients sign each request for its host, so pointing them at another address breaks the
  signature.
- Azure and Vertex clients usually take their endpoint or region in code.
- Any client can hardcode its base URL.

For Node and Python agents, `shadowlap run`, `replay` and `test` also preload a small capture module,
the same way they load the [network guard](./how-it-works.md#the-network-guard). When the agent sends
a request to a host a provider owns, the module sends that request to the sidecar instead, byte for
byte with every signed header, and names the original host in `x-shadowlap-upstream`. The sidecar
records the call and forwards it to that host, or serves it from the recording on replay. The agent's
code and configuration stay as they are.

Other runtimes still record through the base-URL variables. The same capture records
[HTTP services you declare](./sdk.md#http-services-without-wrapping), such as a vector database, as
tool calls.

### What is captured

**Node:** `fetch`, `http.request` and `https.request` (and `get`), `http2.connect`, and WebSockets
(Node's own `WebSocket` and the `ws` package). That covers the AWS SDK
(`@aws-sdk/client-bedrock-runtime`, which speaks HTTP/2), `@anthropic-ai/bedrock-sdk`,
`@anthropic-ai/vertex-sdk`, `@google/genai`, and `AzureOpenAI` and the Realtime clients from `openai`.

**Python:** these libraries, each with the clients that call through it:

| Library | Covers |
|---|---|
| httpx and httpx2 | `anthropic`, `openai`, `google-genai`, including `AnthropicVertex`, `AnthropicBedrock` and `AzureOpenAI` |
| requests | — |
| botocore | `boto3` |
| urllib3 | Clients that drive it themselves (`pinecone`, `elasticsearch`, `opensearch-py`) |
| aiohttp | LiteLLM's async calls, `aiobotocore`, and the `anthropic` and `openai` aiohttp backends |
| websockets | The `openai` Realtime client |

A module is patched when the agent first imports it, so an agent that never imports one pays nothing.

### Hosts

Each provider declares the hosts it owns:

| Provider                       | Hosts                                                                               |
|--------------------------------|-------------------------------------------------------------------------------------|
| Anthropic                      | `api.anthropic.com`                                                                 |
| OpenAI                         | `api.openai.com`                                                                    |
| Google Gemini                  | `generativelanguage.googleapis.com`                                                 |
| Azure OpenAI                   | `*.openai.azure.com`, `*.cognitiveservices.azure.com` and `*.services.ai.azure.com` |
| Claude on Microsoft Foundry    | The `/anthropic` paths of `*.services.ai.azure.com`                                 |
| Vertex AI                      | `aiplatform.googleapis.com` and its regional hosts                                  |
| Amazon Bedrock                 | `bedrock-runtime.<region>.amazonaws.com`                                            |
| OpenAI's SDK on Amazon Bedrock | `bedrock-mantle.<region>.api.aws`                                                   |
| Vercel's AI Gateway            | `ai-gateway.vercel.sh`                                                              |
| Declared hosts                 | The hosts [your config declares](#hosts-of-another-providers-format)                |

The sidecar forwards a captured call only to an `https` origin that matches its provider's hosts (a
declared host with a port, to that port over `http` too). It refuses anything else with a 403, so a
process on your machine can't use the sidecar to relay requests elsewhere.

### How a captured call is sent

- **Signatures.** The path, query, body and signed headers are forwarded unchanged, so SigV4
  signatures and Google and Azure tokens still verify upstream. A request that arrived over HTTP/2 is
  forwarded over HTTP/2 with its original `:authority`, which the AWS SDK signs.
- **Your own base URL.** If `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` or `GOOGLE_GEMINI_BASE_URL`
  already points somewhere (a gateway, a local server), that address becomes the upstream, and calls
  to its host are captured too. An `ANTHROPIC_BASE_URL` that ends in `/v1`, as the AI SDK's Anthropic
  provider reads it, is that root plus `/v1`.
- **Failing a captured call.** A replay that fails a captured HTTP service with
  `--fail-at <call>=timeout` or `error` answers the capture module by name (`x-shadowlap-injected`,
  asked for with `x-shadowlap-failures: raise`). The module raises the client library's own timeout or
  connection error, so the agent's handling of the real thing runs. See
  [Fail a tool](./interventions.md#fail-a-tool).

### OpenAI clients in Node

`shadowlap run` points `OPENAI_BASE_URL` at the sidecar, and an agent's own code reads it there. So a
fallback such as `process.env.OPENAI_BASE_URL ?? 'http://localhost:11434/v1'` never runs.

When you set none of your own, the `openai` package's own default reads nothing, as it would without
shadowlap. A client built without a `baseURL` calls its own host, which capture sends to the sidecar
as what it is: `api.openai.com` as OpenAI, an Azure endpoint as Azure OpenAI. So `AzureOpenAI` takes
its endpoint, which it refuses beside a base URL.

The package's read is told apart by the file it runs from. So in an agent bundled into one minified
file, it reads the sidecar's base URL too, and `AzureOpenAI` with an `endpoint` throws. Build that
client with `baseURL` (the endpoint followed by `/openai`) in its place.

### WebSockets

- **A `wss://` URL to the sidecar.** A client whose base URL is the sidecar makes a `wss://` URL of
  it, as the OpenAI SDK's Realtime clients do, for a sidecar that speaks no TLS. The capture module
  opens it as `ws://`, and the sidecar tunnels it to the provider.
- **A provider's host, in Node.** A WebSocket for a model provider's host opens on the sidecar's route
  for that provider too, its host named in `x-shadowlap-upstream`, as a captured call does.
- **Anything else.** The sidecar tunnels no other WebSocket. So one for an
  [HTTP service you declare](./sdk.md#http-services-without-wrapping) goes where it was going, and the
  network guard sees it as it sees any other connection.

### Turning it off

`SHADOWLAP_CAPTURE=off` leaves the agent's network calls alone. The base-URL variables still apply.

## Credentials on replay

A replayed call never reaches the provider, but the client still has to be willing to send it. A
client that takes its key from the environment gets a [placeholder key](./how-it-works.md#keys) when
the environment has no credential for its provider. On `shadowlap replay`, that happens only where
the recording's environment held the key. The sidecar refuses any live call that would carry one, so
an offline replay, in CI too, needs no model secrets.

| Provider | Placeholder | Unless the environment holds |
|---|---|---|
| Anthropic, OpenAI and Gemini | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY` with `GOOGLE_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` | A key, or another credential the SDKs read |
| Amazon Bedrock | `AWS_ACCESS_KEY_ID=SHADOWLAPREPLAY` and a secret | Any credential source at all |
| Claude on Microsoft Foundry | `ANTHROPIC_FOUNDRY_API_KEY`, only for a recording whose environment held it | It, or Microsoft Entra ID credentials |
| OpenAI's SDK on Amazon Bedrock | `AWS_BEARER_TOKEN_BEDROCK`, only for a recording whose environment held it | AWS credentials |
| Azure OpenAI | `AZURE_OPENAI_API_KEY`, or `AZURE_API_KEY`, only for a recording whose environment held that variable | A key, or Microsoft Entra ID credentials |
| Vercel's AI Gateway | `AI_GATEWAY_API_KEY` | It, or `VERCEL_OIDC_TOKEN` |
| Vertex AI | None: the client fetches an OAuth token first | — |

### Anthropic, OpenAI and Gemini

`GOOGLE_GENERATIVE_AI_API_KEY` is where the AI SDK's Google provider reads it. The other credentials
the SDKs read are `ANTHROPIC_AUTH_TOKEN`, an Anthropic profile and `OPENAI_ADMIN_KEY`.

A golden recorded signed in with an Anthropic profile replays with the placeholder too: the `oauth-`
beta that sign-in adds is no part of what a call is matched by.

### Amazon Bedrock

AWS clients refuse to send a request without credentials. A run with Bedrock calls gets placeholder
credentials, `AWS_ACCESS_KEY_ID=SHADOWLAPREPLAY` and a secret, when the environment has no credential
source at all. None of these is set or present:

- `AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, web identity or container credentials, or
  `AWS_BEARER_TOKEN_BEDROCK`;
- a profile in the shared credentials or config file that holds credentials: keys, a
  `credential_process`, an SSO session, a role to assume, web identity.

A config file that names only a region holds none. The region still has to come from the code or
`AWS_REGION`.

An instance role comes from the metadata service, not the environment. A recording made with one
holds no AWS key in its environment, so `shadowlap replay` leaves the role to the client, while
`shadowlap test`, which needs none, gives the placeholder.

### Claude on Microsoft Foundry

`ANTHROPIC_FOUNDRY_API_KEY`, which `AnthropicFoundry` reads, goes only to a recording whose
environment held it. It is left out when the environment holds it or Microsoft Entra ID credentials:
the client refuses a key beside a token provider. The resource still has to come from the code or
`ANTHROPIC_FOUNDRY_RESOURCE`.

### OpenAI's SDK on Amazon Bedrock

`AWS_BEARER_TOKEN_BEDROCK` is the Bedrock API key its bearer clients read. It goes only to a recording
whose environment held it, unless the environment holds AWS credentials, as Bedrock's above. A client
that signs with SigV4 reads them as the AWS SDKs do.

### Azure OpenAI

`AZURE_OPENAI_API_KEY` goes only to a recording whose environment held that variable. `AZURE_API_KEY`,
where the AI SDK's Azure provider and LiteLLM read it, goes only to one that held that. A recording
that doesn't say gets none, so a key-based client in CI needs `AZURE_OPENAI_API_KEY` set to any value.

Neither is given when the environment holds a key or Microsoft Entra ID credentials
(`AZURE_OPENAI_AD_TOKEN`, `AZURE_CLIENT_ID`, a workload identity, a managed identity): a client with a
token provider refuses a key beside it. An Azure CLI sign-in doesn't count, since the client reads it
only through a token provider the code gives it.

The endpoint and API version still have to come from the code or `AZURE_OPENAI_ENDPOINT` and
`OPENAI_API_VERSION` (`new AzureOpenAI()` throws without them). A client that authenticates with Entra
ID fetches a token first, which a replay can't serve.

### Vercel's AI Gateway

`AI_GATEWAY_API_KEY` is given unless the environment holds it or `VERCEL_OIDC_TOKEN`, the token a
Vercel deployment and `vercel env pull` give.

### Gemini Enterprise Agent Platform (Vertex AI)

Google renamed Vertex AI to Gemini Enterprise Agent Platform on 2026-04-22 ([its announcement](https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform)).
Its API, hosts and SDKs keep the Vertex name (`aiplatform.googleapis.com`, `AnthropicVertex`,
`CLAUDE_CODE_USE_VERTEX`), and these docs and the CLI call it Vertex AI for short.

Google clients fetch an OAuth token before calling Vertex, and that request isn't a model call. In CI,
give the client a token from the environment (`accessToken` in Node, `access_token` in Python), or use
Gemini's express mode with an API key.

The project and region in a call's path don't count when it is matched. So a recording made in one
developer's project replays in another's or in CI's: `ANTHROPIC_VERTEX_PROJECT_ID`,
`GOOGLE_CLOUD_PROJECT` and the region can differ.

## Upstreams

`SHADOWLAP_UPSTREAM_<PROVIDER>` sends a provider's calls somewhere other than where the agent
addressed them: a mock, a staging endpoint, or an OpenAI-compatible server. For captured providers it
replaces the host the agent named.

```sh
SHADOWLAP_UPSTREAM_BEDROCK=http://127.0.0.1:4010 shadowlap run -- python agent.py
```

A name that holds more than letters and digits is written with underscores:
`SHADOWLAP_UPSTREAM_BEDROCK_MANTLE`, and `SHADOWLAP_UPSTREAM_OPENROUTER_AI` for a declared
`openrouter.ai`.

## OpenAI-compatible servers

Ollama, vLLM, OpenRouter, Groq and others speak the OpenAI wire format. Point the provider's upstream
at the server:

```sh
SHADOWLAP_UPSTREAM_OPENAI=http://localhost:11434 shadowlap run -- node agent.js
```

The agent keeps using the `openai` SDK as before. `OPENAI_BASE_URL` routes it through the sidecar,
which forwards to the upstream you named. `SHADOWLAP_UPSTREAM_OPENAI` is the server's address without
`/v1`, which the sidecar adds.

If the project already sets `OPENAI_BASE_URL` to the server, shadowlap uses that and nothing else is
needed, whether its API root ends in `/v1` (`http://localhost:11434/v1`) or not (GitHub Models'
`https://models.github.ai/inference`, Gemini's `https://generativelanguage.googleapis.com/v1beta/openai`).
Each request goes where the SDK would send it without shadowlap, and is recorded as
`POST /v1/chat/completions` either way, so the recording replays without the variable.

[examples/local-model](https://github.com/devjoinedthechat/shadowlap/tree/main/examples/local-model)
does this with the OpenAI Agents SDK and Ollama. GitHub Actions runs it every week against a real
Ollama server: record, replay with the server unreachable, fork, and replay as a golden.

## Hosts of another provider's format

A host can serve another provider's wire format: an OpenAI-compatible gateway (OpenRouter, a company's
own LLM proxy), an Anthropic-compatible one, or a service whose base URL is set in code rather than in
a variable shadowlap can point. Declare each in `shadowlap.config.json`, with the format it speaks
and, when its API sits under a path, the path of the base URL that format's SDK is given there:

```json
{
  "providers": [
    { "host": "openrouter.ai", "format": "openai", "root": "/api/v1" },
    { "host": "*.gateway.example.com", "format": "anthropic" },
    { "host": "localhost:4000", "format": "openai", "root": "/v1" }
  ]
}
```

Each entry takes these fields:

| Field    | Type   | Meaning                                                                               |
|----------|--------|---------------------------------------------------------------------------------------|
| `host`   | string | `api.example.com` or `*.example.com` (any subdomain), either with an optional `:port` |
| `format` | string | The format it speaks: `openai`, `anthropic` or `gemini`                               |
| `root`   | string | Optional: a path such as `/api/v1`, where its API sits                                |

How a declared host's calls are handled:

- **Captured.** In Node and Python agents, a call to a declared host goes to the sidecar as a cloud
  provider's does, with the agent's own headers. Other runtimes don't reach the sidecar for it.
- **Forwarded** to the host it was going to: over `https`, or for a host with a port, to that port
  over `http` too.
- **Recorded as the format's calls.** A call is kept under the format's provider (`meta.provider` is
  `openai`, `anthropic` or `gemini`) and the host it went through (`meta.via`, the host as declared).
  So it streams, counts its usage, shows its conversation and takes [interventions](./interventions.md)
  as that provider's calls do.
- **Named by its path.** Its name keeps the path it was sent to (`POST /api/v1/chat/completions`).
- **Matched as the format names it.** A call under `root` matches as the format's own API names the
  call: at `"root": "/api/v1"`, `/api/v1/chat/completions` matches as OpenAI's `/v1/chat/completions`.
  So a recording replays when the agent's gateway moves.
- **Keys.** A declared host's key is forwarded and never stored, in the format's headers or in
  `x-api-key` and `api-key`; a credential in its query string never is either. A replay gives no
  placeholder for one: an agent whose client needs a key to start needs one set, to any value, in CI.
- **Upstream.** `SHADOWLAP_UPSTREAM_<HOST>`, the host written with underscores, sends its calls to a
  mock or a staging server.

Two hosts are built in:

- **Claude on Microsoft Foundry** is Azure's `/anthropic`
  (`https://<resource>.services.ai.azure.com/anthropic/`), recorded as Anthropic's calls through
  `foundry`.
- **OpenAI's SDK on Amazon Bedrock** is `https://bedrock-mantle.<region>.api.aws/openai/v1`, recorded
  as OpenAI's calls through `bedrock-mantle`.

## Usage

Token usage is extracted from responses for the "tokens not re-spent" number:

| Format | Usage is read from | Also covers |
|---|---|---|
| Anthropic | `usage`, in JSON and in the `message_start` and `message_delta` stream events | Claude on Vertex AI, on Bedrock InvokeModel, and on Microsoft Foundry |
| OpenAI Chat Completions | `prompt_tokens` and `completion_tokens`, including the final usage chunk when `stream_options.include_usage` is set | Azure OpenAI, and OpenAI's SDK on Bedrock |
| The OpenAI Responses API | `response.completed` | Azure OpenAI, and OpenAI's SDK on Bedrock |
| Gemini | `usageMetadata` | The Gemini API and Vertex AI |
| Bedrock Converse | `usage`, in JSON and in the stream's `metadata` event | — |

Bedrock InvokeModel's streams wrap Anthropic's events in AWS event-stream frames.

The model comes from the request body or, for Vertex AI, Bedrock and Azure deployments, from the
path. Prices look through Bedrock's region prefixes and version suffixes
(`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) and Vertex's `@date` form, so those calls are priced
like the models they name.

## Interventions

[Interventions](./interventions.md) change a model request in the provider's own shape, so `--inject`,
`--set` and `--model` work on every provider here, and so does blame's resampling:

| Format | An instruction is | Fields and settings | The model is |
|---|---|---|---|
| Anthropic's Messages API (Anthropic, and Claude on Vertex AI and Bedrock InvokeModel) | A text block on the last user message, or with `--inject-as system` a system message after the conversation | Top-level | The body's `model` on Anthropic; the path on Vertex and Bedrock |
| Chat Completions (OpenAI, Azure OpenAI and OpenAI-compatible servers) | Joined to the closing user message (a string stays a string), or a user message of its own after tool output | Top-level | The body's `model`, or Azure's deployment in the path |
| The Responses API | The same, in `input` | `max_tokens` becomes `max_output_tokens` | As for Chat Completions |
| Gemini, on the Gemini API and Vertex AI | A text part on the user turn, or a user turn of its own after function responses sent in a `function` turn (the older form) | Sampling settings in `generationConfig` | In the path (`--model` takes `gemini-2.5-pro` or `models/gemini-2.5-pro`) |
| Bedrock Converse | A text block on the user turn | Sampling settings in `inferenceConfig`, and `top_k` in `additionalModelRequestFields` | In the path |

- **A system message mid-conversation.** `--inject-as system` is refused on Claude Sonnet 5, which
  takes none mid-conversation. Gemini refuses one too, since it takes system instructions only in
  `systemInstruction`; and so does Converse, which takes system prompts only in `system`.
- **The Responses API's state.** A request that continues with `previous_response_id` sends only the
  turns after the response it continues, and the provider keeps the instruction. A fork's live call
  that continues a recorded response is sent with the whole conversation it continues, and one that
  names a recorded conversation is refused
  ([state kept on the provider's side](./how-it-works.md#where-forks-happen)).
- **Gemini's state.** A fork's live call that names a context cache the recording made is sent with
  the cache's contents instead. One that refers to a file the recording uploaded is sent with the
  file's bytes inline, as one that refers to an OpenAI or Anthropic file is
  ([state kept on the provider's side](./how-it-works.md#where-forks-happen)).

**Bedrock signing.** Bedrock requests are signed for their exact path and body. So a changed one is
signed again with the credentials the agent signed with, when shadowlap can read them: the
environment, or the shared credentials and config files.

Credentials an SSO session or an assumed role keeps inside the client can't sign it. The call is then
answered with that reason instead of being sent, as a `ValidationException` the AWS SDK shows, naming
the access key by its last four characters. Export them for the replay with
`aws configure export-credentials --format env`.

## How each provider is tested

Anthropic, OpenAI and Gemini are exercised end to end by their official SDKs in the test suite,
against scripted fakes of the wire format:

| SDK | What is exercised |
|---|---|
| `@anthropic-ai/sdk` | Streaming, tool use, retries, error responses |
| `openai` | Streaming Chat Completions with tool calls, and the streamed Responses API forked past a response and a conversation the provider keeps |
| `@google/genai` | Streaming `generateContent` with function calls |

Azure OpenAI, Vertex AI and Bedrock are exercised by nine official clients, run by the real CLI:
record, replay with the upstream unreachable, and fork on a changed prompt. Each also forks with an
intervention (`--set`).

| Provider | In Node | In Python |
|---|---|---|
| Amazon Bedrock | The AWS SDK (Converse and ConverseStream over HTTP/2), and `@anthropic-ai/bedrock-sdk` (InvokeModel, streamed and not) | `boto3`, and `anthropic.AnthropicBedrock` (InvokeModel, streamed and not, its `Accept-Encoding` signed too) |
| Vertex AI | `@anthropic-ai/vertex-sdk` with the region in code, and `@google/genai` against Vertex | `anthropic.AnthropicVertex` |
| Azure OpenAI | `AzureOpenAI` with the endpoint in code | `openai.AzureOpenAI` |

- **Through the sidecar.** Claude on Microsoft Foundry and OpenAI's SDK on Bedrock are exercised by
  `@anthropic-ai/sdk` and `openai`, and a declared gateway host by an agent whose `openai` client
  names it in code.
- **Signatures.** The Bedrock fake verifies every request's SigV4 signature against the host it was
  signed for, including the requests a fork changed and shadowlap signed again.

None of the fakes is the real service; if a real API behaves differently, please report what you see.
The OpenAI wire format is also exercised against a real server, Ollama, with the OpenAI Agents SDK
(see [OpenAI-compatible servers](#openai-compatible-servers)).

## Adding a provider

A host that speaks a format shadowlap already reads needs no code: declare it under `providers` in
the config ([above](#hosts-of-another-providers-format)).

A provider is one object in `packages/sidecar/src/providers.ts`, with these fields:

- **`id`, `hosts`, `upstream`, `env(baseUrl)`, `fingerprintHeaders` and `credentialHeaders`.**
- **An optional `apiVersion`:** the fingerprint header every request names the API's version in, and
  the version to name when shadowlap sends a recorded request that names none. A recording whose
  calls name none is matched whatever version a replay names, and the replay names none either.
- **An optional `headerParameters`:** the fingerprint headers that are parameters of the call sent
  beside its body, as Bedrock's guardrail is. A recording made before calls kept them, or imported,
  holds none, and is matched without them.
- **An optional `retryCountHeader`,** and `isRetryableStatus`, `extractUsage`, `extractStopReason`
  and `extractModel`.
- **`keys`,** when its SDKs take a key from the environment: the variables a
  [placeholder key](./how-it-works.md#keys) goes into, those that already hold a credential, and the
  one a refused live call says to set.

A provider with a wire format of its own also needs its request shape in
`packages/engine/src/interventions.ts` (where its turns, sampling settings and model live), or
interventions refuse its requests as not a conversation.

If adding one needs a change in the engine beyond reading its wire format, the abstraction is wrong;
open an issue.

## See also

- [How it works](./how-it-works.md#calls-and-identity): how a call is matched, and the
  [placeholder keys](./how-it-works.md#keys).
- [HTTP services, without wrapping](./sdk.md#http-services-without-wrapping): the same capture, for
  services you declare.
- [Interventions](./interventions.md): `--inject`, `--set` and `--model`.
- [Frameworks](./frameworks.md): how each framework's model client reaches these providers.
