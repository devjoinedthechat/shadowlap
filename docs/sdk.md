# SDKs

API calls need no SDK: the sidecar records them through the provider base URL. The SDKs do two things: wrap **tools** so Shadowlap knows what they do to the world, and record **clock and randomness** so replays see the recorded values.

Without `SHADOWLAP_URL` in the environment (that is, outside `shadowlap run`), every function is a direct passthrough. Wrapped tools ship to production unchanged.

## TypeScript

```ts
import { tool, now, random, uuid, scope, ShadowlapWriteBlocked, ReplayedError } from '@shadowlap/sdk';

export const searchWeb = tool('search_web', { effect: 'read' },
  async ({ query }: { query: string }) => search(query));

export const readFile = tool('read_file', { effect: 'pure' },
  async ({ path }: { path: string }) => files[path]);

export const sendEmail = tool('send_email', {
  effect: 'write',
  onFork: (args) => ({ sent: false, suppressed: true, to: args.to }),   // returned under --writes stub
}, async (args: { to: string; subject: string; body: string }) => mailer.send(args));

const startedAt = await now();          // ms since the epoch; recorded, replayed
const seed = await random();            // [0, 1)
const requestId = await uuid();
```

- `tool(name, { effect, onFork? }, impl)` returns a function with the same signature. Arguments, results and thrown errors must be JSON-serializable. A replayed error is thrown as `ReplayedError` with the recorded `name`, `message` and `code`; the original class is not preserved.
- `effect` is required: `pure` (depends only on the arguments), `read` (touches outside state), `write` (changes it). See [effects](./how-it-works.md#effects).
- After a fork, a `write` tool under the default `--writes block` throws `ShadowlapWriteBlocked`. A well-behaved agent catches tool errors and returns them to the model as an error result; the run then completes and the timeline shows the blocked call.
- A tool that [`--fail-at`](./interventions.md#fail-a-tool) fails throws `ShadowlapInjectedFailure` without running: named `TimeoutError` with code `ETIMEDOUT` for a timeout, with `status` and `statusCode` for an HTTP status, with the given message for an error. `injected` is always `true`.
- `now()`, `random()` and `uuid()` are asynchronous, because Node has no synchronous HTTP. Give concurrent reads a label to disambiguate them: `now('deadline')`.

Node ≥ 18. Zero dependencies.

## Python

```python
from shadowlap import tool, now, random, uuid, ShadowlapWriteBlocked, ReplayedError

@tool(effect="read")
def search_web(query: str, limit: int = 3) -> dict:
    return {"results": search(query, limit)}

@tool(effect="pure")
def read_file(path: str) -> str:
    return FILES[path]

@tool(effect="write", on_fork=lambda to, body: {"sent": False, "suppressed": True})
def send_email(to: str, body: str) -> dict:
    return mailer.send(to, body)

@tool(name="fetch_page", effect="read")
async def fetch(url: str) -> dict: ...          # async functions are supported

started_at = now()      # synchronous
request_id = uuid()
```

- Arguments are recorded by name whether the tool was called positionally or with keywords, with defaults applied.
- Parameters a framework injects (a Pydantic AI `RunContext`, an OpenAI Agents `RunContextWrapper`, a LangChain config, injected graph state) are left out of the recording by their annotation. `exclude=("name",)` drops any other. An argument that can't be recorded as JSON raises `TypeError` before the tool runs, naming the argument. See [Frameworks](./frameworks.md#python).
- A result that is a Pydantic model or a dataclass is recorded as its JSON form, which is what a replay returns.
- `ShadowlapWriteBlocked` has `tool` and `tool_args`. It and `ReplayedError` survive `copy` and `pickle`.
- A tool that [`--fail-at`](./interventions.md#fail-a-tool) fails raises without running: `ShadowlapInjectedTimeout`, a `TimeoutError`, for a timeout; `ShadowlapInjectedHTTPError`, with `status_code`, `status` and `response.status_code`, for an HTTP status; `ShadowlapInjectedFailure`, their base, with the given message for an error. Each has `tool`, `tool_args`, `kind` and `injected = True`, and survives `copy` and `pickle`.
- Python ≥ 3.9. Zero dependencies (`urllib`).

Install from source for now: `pip install -e sdks/python`.

## Scopes

A scope names the branch of the agent a call was made in — one sub-agent of several running at
once — so that identical requests sent at the same time each keep their own recorded answer.
Enter one in code with `scope()`, or, when the branches are separate **processes**, set
`SHADOWLAP_SCOPE` when spawning each child: a worker pool or a subprocess per sub-agent has no
in-process place to call `scope()`, and without one those branches can be served each other's
answers. Scopes entered in code nest underneath it (`worker-2/search`).

When branches of an agent run at once, such as sub-agents fanned out by an orchestrator, name them:

```ts
import { scope } from '@shadowlap/sdk';

const reports = await Promise.all(topics.map((topic, i) => scope(`researcher-${i}`, () => research(topic))));
```

```python
from shadowlap import scope

async def research(i, topic):
    with scope(f"researcher-{i}"):
        ...

reports = await asyncio.gather(*(research(i, t) for i, t in enumerate(topics)))
```

Every call made inside a scope carries it: model calls, wrapped tools and [HTTP services](#http-services-without-wrapping), however deep in awaited code. It changes two things:

- **Matching.** Repeats are counted per scope. Two sub-agents that send the same first request at the same time each get their own recorded answer on replay, whatever order the requests arrive in. Without scopes they can get each other's, and the replay forks when they continue differently.
- **The dashboard.** Turns and the timeline are grouped by scope, so branches that interleave read as separate lines of work.

Scopes nest: a scope inside `orchestrator` is `orchestrator/researcher-0`. In TypeScript the scope follows the async context (`AsyncLocalStorage`); in Python it follows `contextvars`, so asyncio tasks created inside a scope keep it, and a thread started inside one needs `contextvars.copy_context()`. `currentScope()` / `current_scope()` read it. Outside Shadowlap, a scope only runs the code.

A recording made without scopes ignores them on replay, so adding scopes to an agent doesn't make its old recordings fork. Removing them from a recording that had them does. Model calls carry scopes in Node and Python agents, where Shadowlap's preload adds them; other runtimes' model calls don't.

## HTTP services, without wrapping

Retrieval, vector databases and internal APIs are usually called straight from a client library, so there is no function to wrap. Declare their hosts instead, with the effect their calls have:

```json
{
  "http": {
    "*.pinecone.io": "read",
    "localhost:6333": "read",
    "search.internal.example.com": "read",
    "hooks.slack.com": "write"
  }
}
```

In Node and Python agents, requests to those hosts are [captured in the process](./providers.md#in-process-capture) like model calls: `fetch` and `http(s)` in Node; httpx, requests, botocore and urllib3 in Python. Each is recorded as a tool call named after its method, host and path, such as `POST idx-1.svc.pinecone.io/query`, with the request's URL and body as its arguments and the response as its result. From there it behaves like any tool with that effect: replayed before a fork, run live after it when it is `read`, and blocked or stubbed when it is `write`. A blocked call answers the agent with HTTP 409.

- A host is `api.example.com` or `*.example.com` (any subdomain), with an optional `:port`, over `http` or `https`.
- The sidecar makes a live call itself, and only to a declared host.
- Request headers are never stored, so API keys and tokens stay out of recordings. Response bodies are, like any tool result: add [redaction rules](./normalizers-and-redaction.md#redaction) before sharing a pack.
- Responses are buffered, so streamed responses from these services arrive whole.
- `--live-tool 'POST idx-1.svc.pinecone.io/query'` and `--override` work with the tool name.

## The wire protocol

Both SDKs are thin clients of one small HTTP API on the sidecar: `POST /v1/calls/resolve` before a
call, `POST /v1/calls/{callNo}/complete` after it. Model API calls need none of it — they are captured
through the provider's base URL, which works in any language already.

**[The wire protocol](./protocol.md)** specifies it completely, for writing an SDK in a language
Shadowlap does not ship: discovery, headers, every response shape, scopes, errors, and what a client
must do when the sidecar is unreachable. A client that implements it should pass the conformance
suite, which runs against a real sidecar and needs no API keys.
