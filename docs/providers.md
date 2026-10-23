# Providers

The proxy is body-agnostic; a provider module only says which hosts it owns, which headers matter, how retries are marked and how to read token usage. Every provider records into the same run, so an agent that calls Anthropic for planning and Bedrock for tools gets one timeline.

| Provider | How calls reach the sidecar | Fingerprinted headers | Never stored |
|---|---|---|---|
| Anthropic | `ANTHROPIC_BASE_URL` | `anthropic-version`, `anthropic-beta` but for the `oauth-` betas a profile's sign-in adds | `x-api-key`, `authorization`, cookies |
| OpenAI and OpenAI-compatible | `OPENAI_BASE_URL` (with `/v1`) | `openai-beta` | `authorization`, `openai-organization`, `openai-project`, cookies |
| Google Gemini | `GOOGLE_GEMINI_BASE_URL` | none | `x-goog-api-key`, `authorization`, the `?key=` query string |
| Azure OpenAI | in-process capture | `openai-beta` | `api-key`, `authorization`, `openai-organization`, `openai-project`, cookies |
| Vertex AI (Claude and Gemini models) | in-process capture | `anthropic-beta` | `authorization`, `x-goog-api-key`, `x-goog-user-project`, cookies |
| Amazon Bedrock (InvokeModel and Converse, streamed or not) | in-process capture | none | `authorization`, `x-amz-security-token`, `x-amz-date`, `x-amz-content-sha256`, `x-amzn-trace-id`, cookies |

## In-process capture

A base URL can't reach every client. Bedrock clients sign each request for its host, so pointing them at another address breaks the signature. Azure and Vertex clients usually take their endpoint or region in code. And any client can hardcode its base URL.

For Node and Python agents, `shadowlap run`, `replay` and `test` also preload a small capture module, the same way they load the [network guard](./how-it-works.md#the-network-guard). When the agent sends a request to a host a provider owns, the module sends that request to the sidecar instead, byte for byte with every signed header, and names the original host in `x-shadowlap-upstream`. The sidecar records the call and forwards it to that host, or serves it from the recording on replay. The agent's code and configuration stay as they are.

| Runtime | What is captured |
|---|---|
| Node | `fetch`, `http.request` and `https.request` (and `get`), `http2.connect`. Covers the AWS SDK (`@aws-sdk/client-bedrock-runtime`, which speaks HTTP/2), `@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`, `@google/genai` and `AzureOpenAI` from `openai`. |
| Python | httpx and httpx2 (`anthropic`, `openai`, `google-genai`, including `AnthropicVertex`, `AnthropicBedrock` and `AzureOpenAI`), requests, botocore (`boto3`) and urllib3 for clients that drive it themselves (`pinecone`, `elasticsearch`, `opensearch-py`). A module is patched when the agent first imports it, so an agent that never imports one pays nothing. |

Other runtimes still record through the base-URL variables. The same capture records [HTTP services you declare](./sdk.md#http-services-without-wrapping), such as a vector database, as tool calls.

- **Hosts.** Each provider declares the hosts it owns: `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `*.openai.azure.com`, `*.cognitiveservices.azure.com` and `*.services.ai.azure.com`, `aiplatform.googleapis.com` and its regional hosts, and `bedrock-runtime.<region>.amazonaws.com`. The sidecar forwards a captured call only to an `https` origin that matches its provider's hosts and refuses anything else with a 403, so a process on your machine can't use the sidecar to relay requests elsewhere.
- **Signatures.** The path, query, body and signed headers are forwarded unchanged, so SigV4 signatures and Google and Azure tokens still verify upstream. A request that arrived over HTTP/2 is forwarded over HTTP/2 with its original `:authority`, which the AWS SDK signs.
- **Your own base URL.** If `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` or `GOOGLE_GEMINI_BASE_URL` already points somewhere (a gateway, a local server), that address becomes the upstream, and calls to its host are captured too. An `ANTHROPIC_BASE_URL` that ends in `/v1`, as the AI SDK's Anthropic provider reads it, is that root plus `/v1`.
- **Failing a captured call.** A replay that fails a captured HTTP service with `--fail-at <call>=timeout` or `error` answers the capture module by name (`x-shadowlap-injected`, asked for with `x-shadowlap-failures: raise`), and the module raises the client library's own timeout or connection error, so the agent's handling of the real thing runs. See [Fail a tool](./interventions.md#fail-a-tool).
- **Turning it off.** `SHADOWLAP_CAPTURE=off` leaves the agent's network calls alone. The base-URL variables still apply.

### Credentials on replay

A replayed call never reaches the provider, but the client still has to be willing to send it. A client that takes its key from the environment gets a [placeholder key](./how-it-works.md#keys) when the environment has no credential for its provider (on `shadowlap replay`, only where the recording's environment held the key), and the sidecar refuses any live call that would carry one, so an offline replay, in CI too, needs no model secrets:

- **Anthropic, OpenAI and Gemini.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY` with `GOOGLE_API_KEY`, unless the environment holds a key or another credential the SDKs read (`ANTHROPIC_AUTH_TOKEN`, an Anthropic profile, `OPENAI_ADMIN_KEY`). A golden recorded signed in with an Anthropic profile replays with the placeholder too: the `oauth-` beta that sign-in adds is no part of what a call is matched by.
- **Bedrock.** AWS clients refuse to send a request without credentials. A run with Bedrock calls gets placeholder credentials, `AWS_ACCESS_KEY_ID=SHADOWLAPREPLAY` and a secret, when the environment has no credential source at all (no `AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, web identity or container credentials, `AWS_BEARER_TOKEN_BEDROCK`, and no shared config files). The region still has to come from the code or `AWS_REGION`. An instance role comes from the metadata service, not the environment: a recording made with one holds no AWS key in its environment, so `shadowlap replay` leaves the role to the client, while `shadowlap test`, which needs none, gives the placeholder.
- **Azure OpenAI.** `AZURE_OPENAI_API_KEY`, only for a recording whose environment held that variable, unless the environment holds a key or Microsoft Entra ID credentials (`AZURE_OPENAI_AD_TOKEN`, `AZURE_CLIENT_ID`, a workload identity, a managed identity, an Azure CLI sign-in): a client with a token provider refuses a key beside it. A recording that doesn't say gets none, so a key-based client in CI needs `AZURE_OPENAI_API_KEY` set to any value. The endpoint and API version still have to come from the code or `AZURE_OPENAI_ENDPOINT` and `OPENAI_API_VERSION` (`new AzureOpenAI()` throws without them). A client that authenticates with Entra ID fetches a token first, which a replay can't serve.
- **Vertex AI.** Google clients fetch an OAuth token before calling Vertex, and that request isn't a model call. In CI, give the client a token from the environment (`accessToken` in Node, `access_token` in Python) or use Gemini's express mode with an API key. The project and region in a call's path don't count when it is matched, so a recording made in one developer's project replays in another's or in CI's (`ANTHROPIC_VERTEX_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT` and the region can differ).

## Upstreams

`SHADOWLAP_UPSTREAM_<PROVIDER>` sends a provider's calls somewhere other than where the agent addressed them: a mock, a staging endpoint, or an OpenAI-compatible server. For captured providers it replaces the host the agent named.

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

## Usage

Token usage is extracted from responses for the "tokens not re-spent" number:

- Anthropic `usage`, in JSON and in the `message_start` and `message_delta` stream events. This also covers Claude on Vertex AI and on Bedrock InvokeModel, whose streams wrap the same events in AWS event-stream frames.
- OpenAI Chat Completions (`prompt_tokens` and `completion_tokens`, including the final usage chunk when `stream_options.include_usage` is set) and the Responses API (`response.completed`). The same for Azure OpenAI.
- Gemini `usageMetadata`, on the Gemini API and on Vertex AI.
- Bedrock Converse `usage`, in JSON and in the stream's `metadata` event.

The model comes from the request body or, for Vertex AI, Bedrock and Azure deployments, from the path. Prices look through Bedrock's region prefixes and version suffixes (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) and Vertex's `@date` form, so those calls are priced like the models they name.

## Interventions

[Interventions](./interventions.md) change a model request in the provider's own shape, so `--inject`, `--set` and `--model` work on every provider here, and so does blame's resampling:

- **Anthropic, and Claude on Vertex AI and Bedrock InvokeModel** (the Messages API): an instruction is a text block on the last user message, or with `--inject-as system` a system message after the conversation (refused on Claude Sonnet 5, which takes none mid-conversation); fields are top-level; the model is the body's `model` on Anthropic and the path on Vertex and Bedrock.
- **OpenAI, Azure OpenAI and OpenAI-compatible servers** (Chat Completions): an instruction joins the closing user message (a string stays a string), or follows tool output as a user message of its own; fields are top-level; the model is the body's `model`, or Azure's deployment in the path.
- **The Responses API**: the same, in `input`; `max_tokens` becomes `max_output_tokens`. A request that continues with `previous_response_id` sends only new turns, and the provider keeps the instruction.
- **Gemini, on the Gemini API and Vertex AI**: an instruction is a text part on the user turn, or a user turn of its own after function responses sent in a `function` turn (the older form); sampling settings go in `generationConfig`; the model is in the path (`--model` takes `gemini-2.5-pro` or `models/gemini-2.5-pro`). A system message mid-conversation is refused: Gemini takes system instructions only in `systemInstruction`.
- **Bedrock Converse**: an instruction is a text block on the user turn; sampling settings go in `inferenceConfig`, and `top_k` in `additionalModelRequestFields`; the model is in the path. A system message mid-conversation is refused: Converse takes system prompts only in `system`.

Bedrock requests are signed for their exact path and body, so a changed one is signed again with the credentials the agent signed with, when Shadowlap can read them: the environment, or the shared credentials and config files. Credentials an SSO session or an assumed role keeps inside the client can't sign it; the call is then answered with that reason instead of being sent, as a `ValidationException` the AWS SDK shows, naming the access key by its last four characters. Export them for the replay with `aws configure export-credentials --format env`.

## Status

Anthropic, OpenAI and Gemini are exercised end to end by their official SDKs in the test suite against scripted fakes of the wire format: `@anthropic-ai/sdk` (streaming, tool use, retries, error responses), `openai` (streaming Chat Completions with tool calls) and `@google/genai` (streaming `generateContent` with function calls).

Azure OpenAI, Vertex AI and Bedrock are exercised by nine official clients, run by the real CLI: record, replay with the upstream unreachable, and fork on a changed prompt. In Node: the AWS SDK (Converse and ConverseStream over HTTP/2), `@anthropic-ai/bedrock-sdk` (InvokeModel, streamed and not), `@anthropic-ai/vertex-sdk` with the region in code, `@google/genai` against Vertex, and `AzureOpenAI` with the endpoint in code. In Python: `boto3`, `anthropic.AnthropicBedrock` (InvokeModel, streamed and not, its `Accept-Encoding` signed too), `openai.AzureOpenAI` and `anthropic.AnthropicVertex`. Each also forks with an intervention (`--set`). The Bedrock fake verifies every request's SigV4 signature against the host it was signed for, including the requests a fork changed and Shadowlap signed again.

None of the fakes is the real service; if a real API behaves differently, please report what you see. The OpenAI wire format is also exercised against a real server, Ollama, with the OpenAI Agents SDK (see above).

## Adding a provider

A provider is one object in `packages/sidecar/src/providers.ts`: `id`, `hosts`, `upstream`, `env(baseUrl)`, `fingerprintHeaders`, `credentialHeaders`, an optional `apiVersion` (the fingerprint header every request names the API's version in, and the version to name when Shadowlap sends a recorded request that names none: a recording whose calls name none is matched whatever version a replay names, and the replay names none either), an optional `retryCountHeader`, `isRetryableStatus`, `extractUsage`, `extractStopReason` and `extractModel`, and, when its SDKs take a key from the environment, `keys`: the variables a [placeholder key](./how-it-works.md#keys) goes into, those that already hold a credential, and the one a refused live call says to set. A new wire format also needs its request shape in `packages/engine/src/interventions.ts` (where its turns, sampling settings and model live), or interventions refuse its requests as not a conversation. If adding one needs a change in the engine beyond reading its wire format, the abstraction is wrong; open an issue.
