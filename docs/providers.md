# Providers

The proxy is body-agnostic; a provider module only says which hosts it owns, which headers matter, how retries are marked and how to read token usage. Every provider records into the same run, so an agent that calls Anthropic for planning and Bedrock for tools gets one timeline.

| Provider | How calls reach the sidecar | Fingerprinted headers | Never stored |
|---|---|---|---|
| Anthropic | `ANTHROPIC_BASE_URL` | `anthropic-version`, `anthropic-beta` but for the `oauth-` betas a profile's sign-in adds | `x-api-key`, `authorization`, cookies, the `anthropic-organization-id` an answer names |
| OpenAI and OpenAI-compatible | `OPENAI_BASE_URL` (with `/v1`) | `openai-beta` | `authorization`, `openai-organization`, `openai-project`, cookies |
| Google Gemini | `GOOGLE_GEMINI_BASE_URL` | none | `x-goog-api-key`, `authorization`, the `?key=` query string |
| Azure OpenAI | in-process capture | `openai-beta` | `api-key`, `authorization`, `openai-organization`, `openai-project`, cookies |
| Vertex AI (Claude and Gemini models) | in-process capture | `anthropic-beta` | `authorization`, `x-goog-api-key`, `x-goog-user-project`, cookies |
| Amazon Bedrock (InvokeModel and Converse, streamed or not) | in-process capture | what InvokeModel takes as headers: `x-amzn-bedrock-guardrailidentifier`, `x-amzn-bedrock-guardrailversion`, `x-amzn-bedrock-trace`, `x-amzn-bedrock-performanceconfig-latency`, `x-amzn-bedrock-service-tier` | `authorization`, `x-amz-security-token`, `x-amz-date`, `x-amz-content-sha256`, `x-amzn-trace-id`, cookies |
| Claude on Microsoft Foundry (`AnthropicFoundry`), recorded as Anthropic's | in-process capture | `anthropic-version`, `anthropic-beta` | `x-api-key`, `api-key`, `authorization`, cookies, `anthropic-organization-id` |
| OpenAI's SDK on Amazon Bedrock (`bedrock-mantle`), recorded as OpenAI's | in-process capture | `openai-beta`, and the Bedrock headers above | `authorization`, `x-amz-security-token`, `x-amz-date`, `x-amz-content-sha256`, `x-amzn-trace-id`, cookies |
| A host the config declares (`providers`), recorded as the format it names | in-process capture | the format's | the format's, `x-api-key` and `api-key` |

## In-process capture

A base URL can't reach every client. Bedrock clients sign each request for its host, so pointing them at another address breaks the signature. Azure and Vertex clients usually take their endpoint or region in code. And any client can hardcode its base URL.

For Node and Python agents, `shadowlap run`, `replay` and `test` also preload a small capture module, the same way they load the [network guard](./how-it-works.md#the-network-guard). When the agent sends a request to a host a provider owns, the module sends that request to the sidecar instead, byte for byte with every signed header, and names the original host in `x-shadowlap-upstream`. The sidecar records the call and forwards it to that host, or serves it from the recording on replay. The agent's code and configuration stay as they are.

| Runtime | What is captured |
|---|---|
| Node | `fetch`, `http.request` and `https.request` (and `get`), `http2.connect`, and WebSockets (Node's own `WebSocket` and the `ws` package). Covers the AWS SDK (`@aws-sdk/client-bedrock-runtime`, which speaks HTTP/2), `@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`, `@google/genai`, and `AzureOpenAI` and the Realtime clients from `openai`. |
| Python | httpx and httpx2 (`anthropic`, `openai`, `google-genai`, including `AnthropicVertex`, `AnthropicBedrock` and `AzureOpenAI`), requests, botocore (`boto3`), urllib3 for clients that drive it themselves (`pinecone`, `elasticsearch`, `opensearch-py`), aiohttp (LiteLLM's async calls, `aiobotocore`, and the `anthropic` and `openai` aiohttp backends), and websockets (the `openai` Realtime client). A module is patched when the agent first imports it, so an agent that never imports one pays nothing. |

Other runtimes still record through the base-URL variables. The same capture records [HTTP services you declare](./sdk.md#http-services-without-wrapping), such as a vector database, as tool calls.

- **Hosts.** Each provider declares the hosts it owns: `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `*.openai.azure.com`, `*.cognitiveservices.azure.com` and `*.services.ai.azure.com` (whose `/anthropic` paths are Claude on Microsoft Foundry), `aiplatform.googleapis.com` and its regional hosts, `bedrock-runtime.<region>.amazonaws.com`, and `bedrock-mantle.<region>.api.aws`, plus the hosts [your config declares](#hosts-of-another-providers-format). The sidecar forwards a captured call only to an `https` origin that matches its provider's hosts (a declared host with a port, to that port over `http` too) and refuses anything else with a 403, so a process on your machine can't use the sidecar to relay requests elsewhere.
- **Signatures.** The path, query, body and signed headers are forwarded unchanged, so SigV4 signatures and Google and Azure tokens still verify upstream. A request that arrived over HTTP/2 is forwarded over HTTP/2 with its original `:authority`, which the AWS SDK signs.
- **Your own base URL.** If `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` or `GOOGLE_GEMINI_BASE_URL` already points somewhere (a gateway, a local server), that address becomes the upstream, and calls to its host are captured too. An `ANTHROPIC_BASE_URL` that ends in `/v1`, as the AI SDK's Anthropic provider reads it, is that root plus `/v1`.
- **Failing a captured call.** A replay that fails a captured HTTP service with `--fail-at <call>=timeout` or `error` answers the capture module by name (`x-shadowlap-injected`, asked for with `x-shadowlap-failures: raise`), and the module raises the client library's own timeout or connection error, so the agent's handling of the real thing runs. See [Fail a tool](./interventions.md#fail-a-tool).
- **OpenAI clients in Node.** `shadowlap run` points `OPENAI_BASE_URL` at the sidecar, and an agent's own code reads it there, so a fallback such as `process.env.OPENAI_BASE_URL ?? 'http://localhost:11434/v1'` never runs. When you set none of your own, the `openai` package's own default reads nothing, as it would without Shadowlap: a client built without a `baseURL` calls its own host, which capture sends to the sidecar as what it is (`api.openai.com` as OpenAI, an Azure endpoint as Azure OpenAI), so `AzureOpenAI` takes its endpoint, which it refuses beside a base URL. The package's read is told apart by the file it runs from, so in an agent bundled into one minified file it reads the sidecar's base URL too, and `AzureOpenAI` with an `endpoint` throws: build that client with `baseURL` (the endpoint followed by `/openai`) in its place.
- **WebSockets.** A client whose base URL is the sidecar makes a `wss://` URL of it, as the OpenAI SDK's Realtime clients do, for a sidecar that speaks no TLS: the capture module opens it as `ws://`, and the sidecar tunnels it to the provider. In Node, a WebSocket for a model provider's host opens on the sidecar's route for that provider too, its host named in `x-shadowlap-upstream`, as a captured call does. The sidecar tunnels no other WebSocket, so one for an [HTTP service you declare](./sdk.md#http-services-without-wrapping) goes where it was going, and the network guard sees it as it sees any other connection.
- **Turning it off.** `SHADOWLAP_CAPTURE=off` leaves the agent's network calls alone. The base-URL variables still apply.

### Credentials on replay

A replayed call never reaches the provider, but the client still has to be willing to send it. A client that takes its key from the environment gets a [placeholder key](./how-it-works.md#keys) when the environment has no credential for its provider (on `shadowlap replay`, only where the recording's environment held the key), and the sidecar refuses any live call that would carry one, so an offline replay, in CI too, needs no model secrets:

- **Anthropic, OpenAI and Gemini.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY` with `GOOGLE_API_KEY`, unless the environment holds a key or another credential the SDKs read (`ANTHROPIC_AUTH_TOKEN`, an Anthropic profile, `OPENAI_ADMIN_KEY`). A golden recorded signed in with an Anthropic profile replays with the placeholder too: the `oauth-` beta that sign-in adds is no part of what a call is matched by.
- **Bedrock.** AWS clients refuse to send a request without credentials. A run with Bedrock calls gets placeholder credentials, `AWS_ACCESS_KEY_ID=SHADOWLAPREPLAY` and a secret, when the environment has no credential source at all: no `AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, web identity or container credentials, `AWS_BEARER_TOKEN_BEDROCK`, and no profile in the shared credentials or config file that holds credentials (keys, a `credential_process`, an SSO session, a role to assume, web identity). A config file that names only a region holds none. The region still has to come from the code or `AWS_REGION`. An instance role comes from the metadata service, not the environment: a recording made with one holds no AWS key in its environment, so `shadowlap replay` leaves the role to the client, while `shadowlap test`, which needs none, gives the placeholder.
- **Claude on Microsoft Foundry.** `ANTHROPIC_FOUNDRY_API_KEY`, which `AnthropicFoundry` reads, only for a recording whose environment held it, unless the environment holds it or Microsoft Entra ID credentials: the client refuses a key beside a token provider. The resource still has to come from the code or `ANTHROPIC_FOUNDRY_RESOURCE`.
- **OpenAI's SDK on Bedrock.** `AWS_BEARER_TOKEN_BEDROCK`, the Bedrock API key its bearer clients read, only for a recording whose environment held it, unless the environment holds AWS credentials, as Bedrock's above; a client that signs with SigV4 reads them as the AWS SDKs do.
- **Azure OpenAI.** `AZURE_OPENAI_API_KEY`, only for a recording whose environment held that variable, unless the environment holds a key or Microsoft Entra ID credentials (`AZURE_OPENAI_AD_TOKEN`, `AZURE_CLIENT_ID`, a workload identity, a managed identity): a client with a token provider refuses a key beside it. An Azure CLI sign-in doesn't count, since the client reads it only through a token provider the code gives it. A recording that doesn't say gets none, so a key-based client in CI needs `AZURE_OPENAI_API_KEY` set to any value. The endpoint and API version still have to come from the code or `AZURE_OPENAI_ENDPOINT` and `OPENAI_API_VERSION` (`new AzureOpenAI()` throws without them). A client that authenticates with Entra ID fetches a token first, which a replay can't serve.
- **Vertex AI.** Google clients fetch an OAuth token before calling Vertex, and that request isn't a model call. In CI, give the client a token from the environment (`accessToken` in Node, `access_token` in Python) or use Gemini's express mode with an API key. The project and region in a call's path don't count when it is matched, so a recording made in one developer's project replays in another's or in CI's (`ANTHROPIC_VERTEX_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT` and the region can differ).

## Upstreams

`SHADOWLAP_UPSTREAM_<PROVIDER>` sends a provider's calls somewhere other than where the agent addressed them: a mock, a staging endpoint, or an OpenAI-compatible server. For captured providers it replaces the host the agent named. A name that holds more than letters and digits is written with underscores: `SHADOWLAP_UPSTREAM_BEDROCK_MANTLE`, and `SHADOWLAP_UPSTREAM_OPENROUTER_AI` for a declared `openrouter.ai`.

```sh
SHADOWLAP_UPSTREAM_BEDROCK=http://127.0.0.1:4010 shadowlap run -- python agent.py
```

## OpenAI-compatible servers

Ollama, vLLM, OpenRouter, Groq and others speak the OpenAI wire format. Point the provider's upstream at the server:

```sh
SHADOWLAP_UPSTREAM_OPENAI=http://localhost:11434 shadowlap run -- node agent.js
```

The agent keeps using the `openai` SDK as before; `OPENAI_BASE_URL` routes it through the sidecar, which forwards to the upstream you named. `SHADOWLAP_UPSTREAM_OPENAI` is the server's address without `/v1`, which the sidecar adds. If the project already sets `OPENAI_BASE_URL` to the server, Shadowlap uses that and nothing else is needed, whether its API root ends in `/v1` (`http://localhost:11434/v1`) or not (GitHub Models' `https://models.github.ai/inference`, Gemini's `https://generativelanguage.googleapis.com/v1beta/openai`): each request goes where the SDK would send it without Shadowlap, and is recorded as `POST /v1/chat/completions` either way, so the recording replays without the variable.

[examples/local-model](https://github.com/devjoinedthechat/shadowlap/tree/main/examples/local-model) does this with the OpenAI Agents SDK and Ollama. GitHub Actions runs it every week against a real Ollama server: record, replay with the server unreachable, fork, and replay as a golden.

## Hosts of another provider's format

A host can serve another provider's wire format: an OpenAI-compatible gateway (OpenRouter, a company's own LLM proxy), an Anthropic-compatible one, or a service whose base URL is set in code rather than in a variable Shadowlap can point. Declare each in `shadowlap.config.json`, with the format it speaks and, when its API sits under a path, the path of the base URL that format's SDK is given there:

```json
{
  "providers": [
    { "host": "openrouter.ai", "format": "openai", "root": "/api/v1" },
    { "host": "*.gateway.example.com", "format": "anthropic" },
    { "host": "localhost:4000", "format": "openai", "root": "/v1" }
  ]
}
```

- **Captured.** In Node and Python agents, a call to a declared host goes to the sidecar as a cloud provider's does, with the agent's own headers, and is forwarded to the host it was going to: over `https`, or for a host with a port, to that port over `http` too. Other runtimes don't reach the sidecar for it.
- **Recorded as the format's calls.** A call is kept under the format's provider (`meta.provider` is `openai`, `anthropic` or `gemini`) and the host it went through (`meta.via`, the host as declared), so it streams, counts its usage, shows its conversation and takes [interventions](./interventions.md) as that provider's calls do. Its name keeps the path it was sent to (`POST /api/v1/chat/completions`).
- **Matched as the format names it.** A call under `root` matches as the format's own API names the call: at `"root": "/api/v1"`, `/api/v1/chat/completions` matches as OpenAI's `/v1/chat/completions`, so a recording replays when the agent's gateway moves. `host` is `api.example.com` or `*.example.com` (any subdomain), either with an optional `:port`; `root` is a path such as `/api/v1`.
- **Keys.** A declared host's key is forwarded and never stored, in the format's headers or in `x-api-key` and `api-key`; a credential in its query string never is either. A replay gives no placeholder for one: an agent whose client needs a key to start needs one set, to any value, in CI.
- **Upstream.** `SHADOWLAP_UPSTREAM_<HOST>`, the host written with underscores, sends its calls to a mock or a staging server.

Two hosts are built in. Claude on Microsoft Foundry is Azure's `/anthropic` (`https://<resource>.services.ai.azure.com/anthropic/`), recorded as Anthropic's calls through `foundry`. OpenAI's SDK on Amazon Bedrock is `https://bedrock-mantle.<region>.api.aws/openai/v1`, recorded as OpenAI's calls through `bedrock-mantle`.

## Usage

Token usage is extracted from responses for the "tokens not re-spent" number:

- Anthropic `usage`, in JSON and in the `message_start` and `message_delta` stream events. This also covers Claude on Vertex AI, on Bedrock InvokeModel, whose streams wrap the same events in AWS event-stream frames, and on Microsoft Foundry.
- OpenAI Chat Completions (`prompt_tokens` and `completion_tokens`, including the final usage chunk when `stream_options.include_usage` is set) and the Responses API (`response.completed`). The same for Azure OpenAI and for OpenAI's SDK on Bedrock.
- Gemini `usageMetadata`, on the Gemini API and on Vertex AI.
- Bedrock Converse `usage`, in JSON and in the stream's `metadata` event.

The model comes from the request body or, for Vertex AI, Bedrock and Azure deployments, from the path. Prices look through Bedrock's region prefixes and version suffixes (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) and Vertex's `@date` form, so those calls are priced like the models they name.

## Interventions

[Interventions](./interventions.md) change a model request in the provider's own shape, so `--inject`, `--set` and `--model` work on every provider here, and so does blame's resampling:

- **Anthropic, and Claude on Vertex AI and Bedrock InvokeModel** (the Messages API): an instruction is a text block on the last user message, or with `--inject-as system` a system message after the conversation (refused on Claude Sonnet 5, which takes none mid-conversation); fields are top-level; the model is the body's `model` on Anthropic and the path on Vertex and Bedrock.
- **OpenAI, Azure OpenAI and OpenAI-compatible servers** (Chat Completions): an instruction joins the closing user message (a string stays a string), or follows tool output as a user message of its own; fields are top-level; the model is the body's `model`, or Azure's deployment in the path.
- **The Responses API**: the same, in `input`; `max_tokens` becomes `max_output_tokens`. A request that continues with `previous_response_id` sends only new turns, and the provider keeps the instruction. A fork's live call that continues a recorded response is sent with the whole conversation it continues, and one that names a recorded conversation is refused ([state kept on the provider's side](./how-it-works.md#where-forks-happen)).
- **Gemini, on the Gemini API and Vertex AI**: an instruction is a text part on the user turn, or a user turn of its own after function responses sent in a `function` turn (the older form); sampling settings go in `generationConfig`; the model is in the path (`--model` takes `gemini-2.5-pro` or `models/gemini-2.5-pro`). A system message mid-conversation is refused: Gemini takes system instructions only in `systemInstruction`. A fork's live call that names a context cache the recording made is sent with the cache's contents instead, and one that refers to a file the recording uploaded with the file's bytes inline, as one that refers to an OpenAI or Anthropic file is ([state kept on the provider's side](./how-it-works.md#where-forks-happen)).
- **Bedrock Converse**: an instruction is a text block on the user turn; sampling settings go in `inferenceConfig`, and `top_k` in `additionalModelRequestFields`; the model is in the path. A system message mid-conversation is refused: Converse takes system prompts only in `system`.

Bedrock requests are signed for their exact path and body, so a changed one is signed again with the credentials the agent signed with, when Shadowlap can read them: the environment, or the shared credentials and config files. Credentials an SSO session or an assumed role keeps inside the client can't sign it; the call is then answered with that reason instead of being sent, as a `ValidationException` the AWS SDK shows, naming the access key by its last four characters. Export them for the replay with `aws configure export-credentials --format env`.

## Status

Anthropic, OpenAI and Gemini are exercised end to end by their official SDKs in the test suite against scripted fakes of the wire format: `@anthropic-ai/sdk` (streaming, tool use, retries, error responses), `openai` (streaming Chat Completions with tool calls, and the streamed Responses API forked past a response and a conversation the provider keeps) and `@google/genai` (streaming `generateContent` with function calls).

Azure OpenAI, Vertex AI and Bedrock are exercised by nine official clients, run by the real CLI: record, replay with the upstream unreachable, and fork on a changed prompt. In Node: the AWS SDK (Converse and ConverseStream over HTTP/2), `@anthropic-ai/bedrock-sdk` (InvokeModel, streamed and not), `@anthropic-ai/vertex-sdk` with the region in code, `@google/genai` against Vertex, and `AzureOpenAI` with the endpoint in code. Claude on Microsoft Foundry and OpenAI's SDK on Bedrock are exercised through the sidecar by `@anthropic-ai/sdk` and `openai`, and a declared gateway host by an agent whose `openai` client names it in code. In Python: `boto3`, `anthropic.AnthropicBedrock` (InvokeModel, streamed and not, its `Accept-Encoding` signed too), `openai.AzureOpenAI` and `anthropic.AnthropicVertex`. Each also forks with an intervention (`--set`). The Bedrock fake verifies every request's SigV4 signature against the host it was signed for, including the requests a fork changed and Shadowlap signed again.

None of the fakes is the real service; if a real API behaves differently, please report what you see. The OpenAI wire format is also exercised against a real server, Ollama, with the OpenAI Agents SDK (see above).

## Adding a provider

A host that speaks a format Shadowlap already reads needs no code: declare it under `providers` in the config ([above](#hosts-of-another-providers-format)). A provider is one object in `packages/sidecar/src/providers.ts`: `id`, `hosts`, `upstream`, `env(baseUrl)`, `fingerprintHeaders`, `credentialHeaders`, an optional `apiVersion` (the fingerprint header every request names the API's version in, and the version to name when Shadowlap sends a recorded request that names none: a recording whose calls name none is matched whatever version a replay names, and the replay names none either), an optional `headerParameters` (the fingerprint headers that are parameters of the call sent beside its body, as Bedrock's guardrail is: a recording made before calls kept them, or imported, holds none, and is matched without them), an optional `retryCountHeader`, `isRetryableStatus`, `extractUsage`, `extractStopReason` and `extractModel`, and, when its SDKs take a key from the environment, `keys`: the variables a [placeholder key](./how-it-works.md#keys) goes into, those that already hold a credential, and the one a refused live call says to set. A new wire format also needs its request shape in `packages/engine/src/interventions.ts` (where its turns, sampling settings and model live), or interventions refuse its requests as not a conversation. If adding one needs a change in the engine beyond reading its wire format, the abstraction is wrong; open an issue.
