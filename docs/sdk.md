# SDKs

API calls need no SDK: the sidecar records them through the provider base URL. The SDKs wrap **tools** so Shadowlap knows what they do to the world, record **clock and randomness** so replays see the recorded values, and record [what a person types](#what-a-person-types) when it doesn't come from the terminal.

Without `SHADOWLAP_URL` in the environment (that is, outside `shadowlap run`), every function is a direct passthrough. Wrapped tools ship to production unchanged.

## Install

The packages are not on npm or PyPI yet. Until they are, build a clone of the repository as the [quickstart](./quickstart.md) does, and install them from it into your agent's project:

```sh
npm install path/to/shadowlap/packages/sdk          # tools, clock and randomness
npm install path/to/shadowlap/packages/adapters     # framework adapters, next to the SDK
npm install -D path/to/shadowlap/packages/test      # recorded tests: Vitest, node:test
pip install -e path/to/shadowlap/sdks/python        # Python SDK, adapters, pytest plugin
```

npm links each package to the clone, so a rebuild there updates them, and `@shadowlap/test` runs the clone's CLI. `shadowlap init` prints the published names: skip its install step until they exist. The CLI you linked is already on your PATH, and `npx shadowlap` finds it too.

## TypeScript

```ts
import { tool, now, random, uuid, scope, userInput, ShadowlapWriteBlocked, ReplayedError } from '@shadowlap/sdk';

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

- `tool(name, { effect, onFork?, source? }, impl)` returns a function with the same signature. Arguments, results and thrown errors must be JSON-serializable. A replayed error is thrown as `ReplayedError` with the recorded `name`, `message` and `code`; the original class is not preserved, but the error reads as it did: `String(err)`, `util.inspect(err)` and the stack's first line are what they were when the call was recorded.
- `effect` is required: `pure` (depends only on the arguments), `read` (touches outside state), `write` (changes it). See [effects](./how-it-works.md#effects).
- An async generator function (`async function*`, like the AI SDK's streaming `async *execute`) stays one: what it yields is passed on as it comes, its last value is recorded as the result, and a replay yields that value alone. A function that returns a stream without being a generator gets its stream back untouched outside Shadowlap; under it, the stream is read to its end and its last value is the result. Write a streaming tool as `async function*` to keep it streaming while recording.
- A replay warns when a tool's source changed since the recording (`read_policy changed since the recording; pass --live-tool read_policy to run it live`), comparing a hash of `impl`. When `impl` only calls the real code, pass that function as `source`: `tool(name, { effect, source: realFn }, (a) => realFn(a, ctx))`. The [adapters](./frameworks.md) pass the function you gave them.
- Under `--writes stub` a `write` tool doesn't run: it returns what `onFork` gives, or `null` without one, and a replay of the run returns the same.
- After a fork, a `write` tool under the default `--writes block` throws `ShadowlapWriteBlocked`. A well-behaved agent catches tool errors and returns them to the model as an error result; the run then completes and the timeline shows the blocked call.
- A tool that [`--fail-at`](./interventions.md#fail-a-tool) fails throws `ShadowlapInjectedFailure` without running: named `TimeoutError` with code `ETIMEDOUT` for a timeout, with `status` and `statusCode` for an HTTP status, with the given message for an error. `injected` is always `true`.
- `now()`, `random()` and `uuid()` are asynchronous, because Node has no synchronous HTTP. Give concurrent reads a label to disambiguate them: `now('deadline')`.

Node ≥ 18. Zero dependencies. `@shadowlap/sdk` and `@shadowlap/adapters` are ES modules: load them with `import`, or from CommonJS with `await import('@shadowlap/sdk')`; `require()` loads them on Node 20.19, 22.12 and later.

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
- Parameters a framework injects (a Pydantic AI `RunContext`, an OpenAI Agents `RunContextWrapper`, a LangChain config, injected graph state) are left out of the recording by the types in their annotation (an `Annotated` description or a `Literal` value that names one doesn't count). `exclude=("name",)` drops any other framework object; never use it for the tool's real input, which a replay matches the call by. An argument that can't be recorded raises `TypeError` before the tool runs, naming the argument. See [Frameworks](./frameworks.md#python).
- Arguments and results that aren't JSON are recorded in their JSON form, by the same rules: a Pydantic model as `model_dump(mode="json")`, a dataclass as `dataclasses.asdict()`, a date, time or datetime as its ISO 8601 text, a UUID or `Decimal` as its text, an `Enum` as its value, a set as a sorted list, and anything else `pydantic_core` can turn into JSON when it is installed. The tool still gets the objects themselves; a replay returns a result's JSON form. A NaN or Infinity, which JSON has no form for, is recorded as `None`, as `JSON.stringify` records it in TypeScript: the caller gets the tool's own value while recording, and `None` on replay. The same goes for arguments.
- A replayed error is raised as `ReplayedError` with the recorded `name`, `message` and `code`. It reads as the recorded error did: the SDK records an error's module and its arguments too, so `str(err)`, `repr(err)`, `err.args`, `type(err).__name__` and a traceback's last line are what they were (`KeyError('A-17')`, `FileNotFoundError(2, 'No such file or directory')`), and an agent that hands a tool's error to the model sends it the same text on replay. Arguments that JSON can't hold as they are (an object, a tuple) are left out, and `repr()` then shows the message instead.
- An async tool the caller cuts off, as `asyncio.wait_for(search(q), timeout=5)` does at its deadline, is recorded as cancelled, not as the tool's error. Its replay waits until the caller cancels it again, so the deadline fires as it did and the agent's `except asyncio.TimeoutError` runs; a replay where nothing cancels it waits. The same goes for `user_input_async`. Ctrl-C or `sys.exit()` inside a tool is never recorded as its error.
- `ShadowlapWriteBlocked` has `tool` and `tool_args`. It and `ReplayedError` survive `copy` and `pickle`.
- A tool that [`--fail-at`](./interventions.md#fail-a-tool) fails raises without running: `ShadowlapInjectedTimeout`, a `TimeoutError`, for a timeout; `ShadowlapInjectedHTTPError`, with `status_code`, `status` and `response.status_code`, for an HTTP status; `ShadowlapInjectedFailure`, their base, with the given message for an error. Each has `tool`, `tool_args`, `kind` and `injected = True`, and survives `copy` and `pickle`.
- Python ≥ 3.9. Zero dependencies (`urllib`).

## What a person types

An agent that waits for a person can't be replayed by itself: no one is there to type. Shadowlap
records each answer as a `user_input` call (a read, with the prompt as its argument and
`{ "text": … }` as its result), so the run replays, tests and blames with no one at the keyboard.
`shadowlap test`, `blame` and `verify` start agents with their input ignored, and the recorded
answers carry them through.

Input from the terminal is recorded with no code change, by the preloads `shadowlap run` adds:

- **Python:** `input()`, and `sys.stdin.readline()`, `read()`, `readlines()` and `for line in sys.stdin`.
- **Node:** readline's `rl.question()` (callback, `readline/promises` and `util.promisify`) and `for await (const line of rl)`. Lines read through `'line'` events, or straight from `process.stdin`, are not recorded: wrap that read in `userInput()`.

Only the input `shadowlap` gave the agent counts: a terminal, the null device, or the pipe or file
`shadowlap` itself was given. A child process reading a pipe from its parent, an MCP server for one,
is left alone. Python's `getpass` is never recorded. On Windows, Node and Python can't tell one pipe
from another, so input given through a pipe isn't recorded there; what is typed in a terminal, or
read from a file given as the input (`< answers.txt`), is.

For input that arrives some other way (a chat window, a message from a queue), wrap the read:

```ts
import { userInput } from '@shadowlap/sdk';

const reply = await userInput('How can I help?', () => chatWindow.nextMessage());
```

```python
from shadowlap import user_input, user_input_async

reply = user_input("How can I help? ")                                  # input() by default
reply = user_input("How can I help? ", read=lambda p: queue.get())
reply = await user_input_async("How can I help? ", lambda p: websocket.recv())
reply = await user_input_async("How can I help? ", lambda p: asyncio.to_thread(input, p))
```

A read inside `user_input()` or `user_input_async()` that goes through `input()` or `sys.stdin`,
on a worker thread included, is recorded once: as the answer of the wrapping call.

On replay the answers come from the recording; `read` isn't called. After a fork there is still no
one to type, so the recorded answers are served in the order they were given, whatever the prompt
now says, and `replay --live-input` asks for them instead. To try a different answer, override the
call: `shadowlap replay <run> --override 5='{"text": "A refund, please."}'`. When the input ended
(Ctrl-D, an empty pipe), that is recorded too, and a replay ends the input at the same place. A
recording made before Shadowlap recorded input holds none of it: replaying it, the agent reads its
input live, as it did then, and the rest still replays. See
[examples/support-chat](https://github.com/devjoinedthechat/shadowlap/tree/main/examples/support-chat).

## Scopes

A scope names the branch of the agent a call was made in — one sub-agent of several running at
once — so that identical requests sent at the same time each keep their own recorded answer.
Enter one in code with `scope()`, or, when the branches are separate **processes**, set
`SHADOWLAP_SCOPE` when spawning each child: a worker pool or a subprocess per sub-agent has no
in-process place to call `scope()`, and without one those branches can be served each other's
answers. Scopes entered in code nest underneath it (`worker-2/search`). A scope can be named in any
language: `scope('東京の天気', ...)` works as `scope('weather', ...)` does.

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
- [`--fail-at <call>=timeout` or `error`](./interventions.md#fail-a-tool) raises what the client library raises for the real failure: a `TimeoutError` or `TypeError: fetch failed` from `fetch`, the request's own `timeout` event and then `ETIMEDOUT` or `ECONNRESET` from `http(s).request`, `ReadTimeout` or `ReadError` from httpx, and urllib3's `ReadTimeoutError` or `ProtocolError`, which requests and botocore turn into their own. A status comes back as that response.

## The wire protocol

Both SDKs are thin clients of one small HTTP API on the sidecar: `POST /v1/calls/resolve` before a
call, `POST /v1/calls/{callNo}/complete` after it. Model API calls need none of it — they are captured
through the provider's base URL, which works in any language already.

**[The wire protocol](./protocol.md)** specifies it completely, for writing an SDK in a language
Shadowlap does not ship: discovery, headers, every response shape, scopes, errors, and what a client
must do when the sidecar is unreachable. A client that implements it should pass the conformance
suite, which runs against a real sidecar and needs no API keys.
