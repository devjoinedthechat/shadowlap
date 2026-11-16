# SDKs

The SDKs wrap **tools** so shadowlap knows what they do to the world, record **clock and randomness**
so replays see the recorded values, and record [what a person types](#what-a-person-types) when it
doesn't come from the terminal. API calls need no SDK: the sidecar records them through the provider
base URL.

Without `SHADOWLAP_URL` in the environment (that is, outside `shadowlap run`), every function is a
direct passthrough. Wrapped tools ship to production unchanged.

This page covers:

- [Install](#install)
- [Wrap a tool](#wrap-a-tool): effects, results, errors, streams and writes after a fork
- [Untrusted reads](#untrusted-reads)
- [Record the clock and randomness](#record-the-clock-and-randomness)
- [What a person types](#what-a-person-types)
- [Scopes](#scopes)
- [HTTP services, without wrapping](#http-services-without-wrapping)
- [API reference](#api-reference) and [requirements](#requirements)

## Install

Into your agent's project:

```sh
# Node 18.18+
npm install @shadowlap/sdk         # wrap tools
npm install @shadowlap/adapters    # wrap them in your framework
# Node 22.17+, not 23
npm install -D @shadowlap/test     # record tests in Vitest, Jest or node:test
# Python 3.9+
pip install shadowlap              # all three in one package
```

| Package               | What it brings                                           |
|-----------------------|----------------------------------------------------------|
| `@shadowlap/sdk`      | Wraps tools, and records the clock and randomness        |
| `@shadowlap/adapters` | Declares effects through your framework, next to the SDK |
| `@shadowlap/test`     | Records tests, and brings the `shadowlap` CLI it runs    |
| `shadowlap` (pip)     | The SDK, the adapters and the pytest plugin              |

[`shadowlap init`](./cli.md#init) prints the install step with your project's package manager.

### The `shadowlap` command from pip

`pip install shadowlap` also puts a `shadowlap` command on your `PATH`, for a Python project with no
npm in it. It runs the CLI from npm at the Python package's own version, so the two always speak the
same protocol:

- a `shadowlap` of that version installed with npm, when one is on `PATH`;
- otherwise `npx --yes shadowlap@<version>`, which fetches it once.

The CLI runs on Node.js 22.17 or later (not 23). Without one, the command says so and how to get it,
and exits 2. `SHADOWLAP_CLI` names another CLI to run instead, as it does for the
[pytest plugin](./testing.md#pytest).

The command never runs itself. When what it runs runs it again, as `SHADOWLAP_CLI=shadowlap` would
(which names this command rather than the CLI), it says so and exits 2 rather than go on without end.

## Wrap a tool

Give each tool a name and an effect. In TypeScript:

```ts
import { tool } from '@shadowlap/sdk';

export const searchWeb = tool('search_web', { effect: 'read' },
  async ({ query }: { query: string }) => search(query));

export const readFile = tool('read_file', { effect: 'pure' },
  async ({ path }: { path: string }) => files[path]);

export const sendEmail = tool('send_email', {
  effect: 'write',
  onFork: (args) => ({ sent: false, suppressed: true, to: args.to }),   // returned under --writes stub
}, async (args: { to: string; subject: string; body: string }) => mailer.send(args));
```

In Python:

```python
from shadowlap import tool

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
```

`tool(name, { effect, onFork?, source?, trust? }, impl)` returns a function with the same signature.
In Python, a tool keeps its kind: a coroutine function stays awaitable, and a generator keeps
streaming ([streaming tools](#streaming-tools)).

### Effects

`effect` is required. See [effects](./how-it-works.md#effects).

| Effect  | The tool                      |
|---------|-------------------------------|
| `pure`  | Depends only on the arguments |
| `read`  | Touches outside state         |
| `write` | Changes it                    |

`trust: 'untrusted'` (`trust="untrusted"` in Python) marks a read that brings outside text in: see
[untrusted reads](#untrusted-reads).

### Writes after a fork

- **Blocked.** After a fork, a `write` tool under the default `--writes block` throws
  `ShadowlapWriteBlocked`. A well-behaved agent catches tool errors and returns them to the model as an
  error result; the run then completes and the timeline shows the blocked call.
- **Stubbed.** Under `--writes stub` a `write` tool doesn't run: it returns what `onFork` (`on_fork`
  in Python) gives, or `null` without one, and a replay of the run returns the same.
- **In Python,** `ShadowlapWriteBlocked` has `tool` and `tool_args`. It and `ReplayedError` survive
  `copy` and `pickle`.

### Arguments and results

In TypeScript, arguments, results and thrown errors must be JSON-serializable.

In Python, arguments are recorded by name whether the tool was called positionally or with keywords,
with defaults applied. Arguments and results that aren't JSON are recorded in their JSON form, by the
same rules:

| Python value             | Recorded as                                                   |
|--------------------------|---------------------------------------------------------------|
| A Pydantic model         | `model_dump(mode="json")`                                     |
| A dataclass              | `dataclasses.asdict()`                                        |
| A date, time or datetime | Its ISO 8601 text                                             |
| A UUID or `Decimal`      | Its text                                                      |
| An `Enum`                | Its value                                                     |
| A set                    | A sorted list                                                 |
| A NaN or Infinity        | `None`, as `JSON.stringify` records it in TypeScript          |
| Anything else            | What `pydantic_core` can turn into JSON, when it is installed |

- **The tool still gets the objects themselves;** a replay returns a result's JSON form.
- **Numbers** come back as the tool returned them, an int past 2^53 and a float such as `20.0`
  included.
- **A dict key that isn't a string** (`{2026: 5}`) raises `TypeError` naming it, since JSON keeps it
  only as `"2026"` and a replay would return that.
- **A NaN or Infinity,** which JSON has no form for, reaches the caller as the tool's own value while
  recording, and as `None` on replay. The same goes for arguments.

### Parameters left out of the recording (Python)

Parameters a framework injects (a Pydantic AI `RunContext`, an OpenAI Agents `RunContextWrapper`, a
LangChain config, injected graph state) are left out of the recording by the types in their
annotation. An `Annotated` description or a `Literal` value that names one doesn't count. See
[Frameworks](./frameworks.md#python).

- **A method's `self`**, or a classmethod's `cls`, is left out too when `@tool` wraps one in its class.
- **`exclude=("name",)`** drops any other framework object. Never use it for the tool's real input,
  which a replay matches the call by.
- **An argument that can't be recorded** raises `TypeError` before the tool runs, naming the argument.

### Errors a replay throws

A replayed error is thrown as `ReplayedError` with the recorded `name`, `message` and `code`.

**In TypeScript:**

- **Its own fields.** It keeps the error's own fields that JSON keeps as they are: a file system
  error's `errno`, `syscall`, `path` and `dest`, an HTTP client error's `status`. Only strings,
  numbers, booleans and null: nothing nested, which can hold a request's headers.
- **Its response.** Of the response an HTTP client's error carries, as Axios's does, it keeps
  `response.status` and `response.statusText` alone, never its headers, data or config.
- **How it reads.** The original class is not preserved, but the error reads as it did: `String(err)`,
  `util.inspect(err)` and the stack's first line are what they were when the call was recorded.

**In Python** (raised rather than thrown):

- **How it reads.** The SDK records an error's module and its arguments too. So `str(err)`,
  `repr(err)`, `err.args`, `type(err).__name__` and a traceback's last line are what they were
  (`KeyError('A-17')`, `FileNotFoundError(2, 'No such file or directory')`).
- **The model sees the same text.** An agent that hands a tool's error to the model sends it the same
  text on replay.
- **Its class.** A builtin's is an instance of that builtin too, so the agent's `except KeyError` or
  `except OSError` catches it as it caught the original. It has its `errno` and its `filename` and
  `filename2` (an OSError's files, which its arguments leave out).
- **Not `SystemExit` or `KeyboardInterrupt`.** Those end a program, and a replayed error is not taken
  as theirs.
- **Its own attributes.** It has the error's own plain attributes again, such as openai's
  `status_code` and `request_id`: a `str`, `int`, `float`, `bool` or `None`, nothing nested, which can
  hold a request and its headers.
- **Its response.** Of the response it carries (httpx's, requests'), it keeps `response.status_code`
  and reason alone, never its headers or content, as the Node SDK keeps an error's own fields and its
  response's status.
- **Arguments JSON can't hold as they are** (an object, a tuple) are left out, and `repr()` then shows
  the message instead.

### Streaming tools

A streaming tool stays one under shadowlap. In TypeScript, write it as an async generator function
(`async function*`, like the AI SDK's streaming `async *execute`). In Python, an async generator
function (or a plain generator function) keeps streaming:

```ts
export const watchOrder = tool('watch_order', { effect: 'read' },
  async function* ({ orderId }: { orderId: string }) {
    for await (const status of orders.updates(orderId)) yield status;
  });
```

```python
@tool(effect="read")
async def watch_order(order_id: str):           # an async generator: the tool streams
    async for status in orders.updates(order_id):
        yield status
```

**Recording.** It runs at the pace of whoever reads it, as it does outside shadowlap. Every value it
yields is recorded, in order, as `{ "shadowlap_stream": [...] }`, with what it returns as `returned`.
In Python, values sent in and errors thrown in reach the tool, and the form is
`{"shadowlap_stream": [...]}` with a generator's return value too.

**Replay.** A replay yields them again, in order, so the AI SDK takes the last for the tool's output
as it did live. In Python an empty stream yields nothing, and a generator returns what it returned. A
stream that failed part way replays the values it yielded first, then its error.

**A reader that stops early** (`break`, an aborted stream, `aclose()` in Python) stops the tool there.
What it read is recorded, up to the last value it read, as closed (`"closed": true`). A replay that
reads on past it forks there:

- the rest is a call of its own (its arguments with `shadowlap_stream_after`, the values already
  given) that no recording holds;
- it runs live from the start past those values, or is blocked or stubbed as a write after a fork is.

**Other cases:**

- **A stream recorded as one value,** as before or as an `--override` gives it, replays that value
  alone.
- **A function that returns a stream without being a generator** (TypeScript) gets its stream back
  untouched outside shadowlap. Under it, the stream is read to its end and its last value is the
  result. Write a streaming tool as `async function*` to keep it streaming while recording.
- **An object whose `__call__` is one of these** (Python), as frameworks build tool classes, is
  wrapped the same way, and named after its class unless you pass `name`.

### When the tool's code changes

A replay warns when a tool's source changed since the recording
(`read_policy changed since the recording; pass --live-tool read_policy to run it live`), comparing a
hash of `impl`. When `impl` only calls the real code, pass that function as `source`:
`tool(name, { effect, source: realFn }, (a) => realFn(a, ctx))`. The [adapters](./frameworks.md) pass
the function you gave them.

The hash covers that function alone, not what it reads: a constant in another file can change with no
warning of a changed tool. When no request differed in any run, verify warns that the change made no
difference ([a fix inside a tool](./verify.md#a-fix-inside-a-tool)).

### Failures `--fail-at` injects

A tool that [`--fail-at`](./interventions.md#fail-a-tool) fails throws without running:

| Failure | TypeScript | Python |
|---|---|---|
| A timeout | `ShadowlapInjectedFailure`, named `TimeoutError` with code `ETIMEDOUT` | `ShadowlapInjectedTimeout`, a `TimeoutError` |
| An HTTP status | `ShadowlapInjectedFailure`, with `status` and `statusCode` | `ShadowlapInjectedHTTPError`, with `status_code`, `status` and `response.status_code` |
| An error | `ShadowlapInjectedFailure`, with the given message | `ShadowlapInjectedFailure`, their base, with the given message |

In TypeScript, `injected` is always `true`. In Python, each has `tool`, `tool_args`, `kind` and
`injected = True`, and survives `copy` and `pickle`.

### Async tools in Python

Async tools run under asyncio, trio, and anyio on either backend. The SDK asks sniffio, which trio and
anyio install, which library runs the task. It calls the sidecar from that library's worker threads,
so the event loop never waits on it.

- **A caller's deadline.** An async tool the caller cuts off, as
  `asyncio.wait_for(search(q), timeout=5)` does at its deadline, is recorded as cancelled, not as the
  tool's error.
- **Its replay** waits until the caller cancels it again, so the deadline fires as it did and the
  agent's `except asyncio.TimeoutError` runs. A replay where nothing cancels it waits.
- **trio and anyio.** A cancel scope that cuts a call off (`trio.move_on_after`, `anyio.fail_after`)
  is recorded as cancelled, as an asyncio deadline is.
- **While the sidecar answers,** the SDK holds the cancel in that library's own shielded scope, on
  asyncio under anyio too. So the wait costs no CPU, and the cancel reaches the caller as the answer
  comes.
- **`user_input_async`** is cancelled the same way.
- **Ctrl-C or `sys.exit()`** inside a tool is never recorded as its error.

## Untrusted reads

A tool whose result can carry text someone else wrote (a web page, an email, a ticket, a document,
a search result) is where a prompt injection arrives. Mark it, and
[`shadowlap injection`](./injection.md) plants payloads in what it returns, to prove whether the
agent obeys them:

```ts
export const fetchPage = tool('fetch_page', { effect: 'read', trust: 'untrusted' },
  async ({ url }: { url: string }) => fetchText(url));
```

```python
@tool(effect="read", trust="untrusted")
def fetch_page(url: str) -> dict:
    return fetch_text(url)
```

- **On each call.** The mark is recorded on each call (`meta.trust`, with `meta.trustFrom`), and
  never enters its fingerprint: marking a tool keeps every recording of it.
- **Values.** The default is `trusted`; anything but `trusted` or `untrusted` is refused when the tool
  is made.
- **Adapters.** The framework adapters pass it on: `{ effect: 'read', trust: 'untrusted' }` in
  TypeScript, and `trust="untrusted"` to `with_effect` and `function_tool` in Python.
- **In the config,** without touching the code: `"tools": { "fetch_page": { "trust": "untrusted" } }`.
  A host under `http` is marked by its name.
- **The config wins.** The config's mark is recorded on each call too, so a run keeps it wherever it
  is opened. The config read when a run is tested wins over every recorded mark:
  `"trust": "trusted"` unmarks a tool.
- **MCP.** Behind [`shadowlap mcp`](./mcp.md#effects), a read tool whose server sets `openWorldHint`
  is untrusted already.

## Record the clock and randomness

Read the time, a random number or a UUID through the SDK, and a replay sees the recorded values:

```ts
import { now, random, uuid } from '@shadowlap/sdk';

const startedAt = await now();          // ms since the epoch; recorded, replayed
const seed = await random();            // [0, 1)
const requestId = await uuid();
```

```python
from shadowlap import now, random, uuid

started_at = now()      # synchronous
seed = random()         # [0, 1)
request_id = uuid()
```

- **TypeScript:** `now()`, `random()` and `uuid()` are asynchronous, because Node has no synchronous
  HTTP.
- **Python:** they are synchronous.
- **Labels.** Give concurrent reads a label to disambiguate them: `now('deadline')`.

## What a person types

An agent that waits for a person can't be replayed by itself: no one is there to type. shadowlap
records each answer as a `user_input` call (a read, with the prompt as its argument and
`{ "text": … }` as its result), so the run replays, tests and blames with no one at the keyboard.
`shadowlap test`, `blame` and `verify` start agents with their input ignored, and the recorded
answers carry them through.

### From the terminal

Input from the terminal is recorded with no code change, by the preloads `shadowlap run` adds:

| Runtime | Recorded |
|---|---|
| Python | `input()`, and `sys.stdin.readline()`, `read()`, `readlines()` and `for line in sys.stdin` |
| Node | readline's `rl.question()` (callback, `readline/promises` and `util.promisify`) and `for await (const line of rl)` |

- **Node's other reads.** Lines read through `'line'` events, or straight from `process.stdin`, are
  not recorded: wrap that read in `userInput()`.
- **Only the input `shadowlap` gave the agent counts:** a terminal, the null device, or the pipe or
  file `shadowlap` itself was given. A child process reading a pipe from its parent, an MCP server for
  one, is left alone.
- **Python's `getpass`** is never recorded.
- **On Windows,** Node and Python can't tell one pipe from another, so input given through a pipe
  isn't recorded there. What is typed in a terminal, or read from a file given as the input
  (`< answers.txt`), is.

### From anywhere else

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

### On replay

- **From the recording.** The answers come from the recording; `read` isn't called.
- **After a fork** there is still no one to type, so the recorded answers are served in the order
  they were given, whatever the prompt says at that point. `replay --live-input` asks for them
  instead.
- **A different answer.** Override the call:
  `shadowlap replay <run> --override 5='{"text": "A refund, please."}'`.
- **The end of the input.** When the input ended (Ctrl-D, an empty pipe), that is recorded too, and a
  replay ends the input at the same place.
- **Older recordings.** A recording made before shadowlap recorded input holds none of it. Replaying
  it, the agent reads its input live, as it did then, and the rest still replays.

See [examples/support-chat](https://github.com/devjoinedthechat/shadowlap/tree/main/examples/support-chat).

## Scopes

A scope names the branch of the agent a call was made in — one sub-agent of several running at
once — so that identical requests sent at the same time each keep their own recorded answer. When
branches of an agent run at once, such as sub-agents fanned out by an orchestrator, name them:

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

Every call made inside a scope carries it: model calls, wrapped tools and
[HTTP services](#http-services-without-wrapping), however deep in awaited code. It changes two things:

- **Matching.** Repeats are counted per scope. Two sub-agents that send the same first request at the
  same time each get their own recorded answer on replay, whatever order the requests arrive in.
  Without scopes they can get each other's, and the replay forks when they continue differently.
- **The dashboard.** Each scope is an agent there, under the name you gave it. The dashboard finds a
  run's agents without scopes too ([Agents](./dashboard.md#agents)), so a scope keeps concurrent
  branches' answers apart rather than being needed to show them.

### Branches in separate processes

Enter a scope in code with `scope()`. When the branches are separate **processes**, set
`SHADOWLAP_SCOPE` when spawning each child: a worker pool or a subprocess per sub-agent has no
in-process place to call `scope()`, and without one those branches can be served each other's
answers. Scopes entered in code nest underneath it (`worker-2/search`).

### Names and nesting

- **Any language.** A scope can be named in any language: `scope('東京の天気', ...)` works as
  `scope('weather', ...)` does.
- **Reserved names.** Names that start with `shadowlap:` are shadowlap's own (a
  [judge check](./judges.md)'s calls are made in `shadowlap:judge`): a call made in one is refused.
- **Nesting.** Scopes nest: a scope inside `orchestrator` is `orchestrator/researcher-0`.
- **Reading it.** `currentScope()` / `current_scope()` read it.
- **Outside shadowlap,** a scope only runs the code.

How a scope follows the code:

| Language | It follows | So |
|---|---|---|
| TypeScript | The async context (`AsyncLocalStorage`) | — |
| Python | `contextvars` | asyncio tasks created inside a scope keep it, and a thread started inside one needs `contextvars.copy_context()` |

### Scopes and recordings

- **Adding scopes.** A recording made without scopes ignores them on replay, so adding scopes to an
  agent doesn't make its old recordings fork. Removing them from a recording that had them does.
- **Model calls.** Model calls carry scopes in Node and Python agents, where shadowlap's preload adds
  them, whatever client sends them (`fetch`, `http.request` under node-fetch or axios, httpx,
  requests, urllib3). Other runtimes' model calls don't.
- **`SHADOWLAP_SCOPE`.** A process started with it carries it on its model calls as on its tools.

## HTTP services, without wrapping

Retrieval, vector databases and internal APIs are usually called straight from a client library, so
there is no function to wrap. Declare their hosts instead, with the effect their calls have:

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

In Node and Python agents, requests to those hosts are
[captured in the process](./providers.md#in-process-capture) like model calls: `fetch` and `http(s)`
in Node; httpx, requests, botocore, urllib3 and aiohttp in Python. Each is recorded as a tool call
named after its method, host and path, such as `POST idx-1.svc.pinecone.io/query`, with the
request's URL and body as its arguments and the response as its result.

From there it behaves like any tool with that effect: replayed before a fork, run live after it when
it is `read`, and blocked or stubbed when it is `write`.

- **Bytes as sent.** A replayed call answers with the bytes the service sent. A JSON response keeps
  its layout, escapes and numbers (a 64-bit id, `20.0`), so an agent that reads the text, or a number
  JSON parsing would round, gets what it got then.
- **Blocked calls.** A blocked call answers the agent with HTTP 409.
- **Hosts.** A host is `api.example.com` or `*.example.com` (any subdomain), with an optional
  `:port`, over `http` or `https`.
- **Whole services.** A whole service the agent calls, such as another team's agent behind an
  endpoint, is declared the same way: [agents across services](./downstream-services.md).
- **Live calls.** The sidecar makes a live call itself, and only to a declared host.
- **Streams.** Responses are buffered, so streamed responses from these services arrive whole.
- **Flags.** `--live-tool 'POST idx-1.svc.pinecone.io/query'` and `--override` work with the tool name.

### Redaction in a call's name

A [redaction rule](./normalizers-and-redaction.md#redaction) without a path masks what it matches in
that name too, in every copy, as in the URL. A pack of `GET crm.example.com/contacts/alice@example.com`
under the email rule holds `GET crm.example.com/contacts/<REDACTED>`, and its replay matches the live
call by that masked name.

A rule scoped to such a call by `--name` carries that name, path and all, into every copy, since a
copy records its rules. Scope it with `--kind tool` instead.

### Credentials

Request headers are never stored, so API keys and tokens stay out of recordings. Credentials in these
places are stored as `<CREDENTIAL>` instead:

| Where | Stored as `<CREDENTIAL>` |
|---|---|
| The query string, or a form body | A parameter named as a credential, such as `key`, `api_key`, `access_token`, `client_secret`, `sig` or `X-Amz-Signature` |
| A JSON body | Its credential members, by name at any depth, as `{"api_key": …, "client_secret": …}` |
| A Kubernetes Secret | Its `data` and `stringData` |
| A multipart body | Its credential fields |
| An XML body | Its credential elements |
| A response | A token in a response header, a redirect's `location` or a `www-authenticate` challenge; an OAuth token response's `access_token` and `refresh_token` |
| A secret store's answer | The secret it holds, read by its shape: a Kubernetes Secret's `data`, Secret Manager's `payload.data`, Azure Key Vault's `value`, Vault's KV `data` |
| A write to a secret store | The secret it sends, by the call's address: a Vault KV write's, Key Vault's `value`, Secret Manager's `payload`, a Kubernetes Secret patch's `data` |
| The URL's path | A webhook's secret (Slack's, Discord's, a Telegram bot's), and a path parameter named as a credential (`;jsessionid=`) |

- **Query strings and form bodies.** A credential there is forwarded as sent and stored as
  `<CREDENTIAL>`, and the call is matched that way, so a replay with a rotated key still replays. A
  form body is `application/x-www-form-urlencoded`, or a text body written as one.
- **Bodies, by their shape.** A body's credentials are read by its shape whatever its content type
  says, also in JSON a `fetch` string body sends as `text/plain` or in lines of JSON, and matched that
  way.
- **Responses.** What a response hands back is masked in place, the rest of the body as the service
  sent it.
- **Paths.** A path's credential is stored as `<CREDENTIAL>` in the call's name too. A key anywhere
  else in the path is stored like any tool result: add
  [redaction rules](./normalizers-and-redaction.md#redaction) before sharing a pack.
- **Matching.** A value stored as `<CREDENTIAL>` no longer tells two calls apart: calls that differ
  only in it match each other's recordings, in the order they come.

What stays a value like any other:

- **A sort key or a page token.**
- **A name that names or describes a secret** rather than holding it, such as `secret_name`,
  `secret_arn`, `SecretId` or `password_policy`, with a value that doesn't read as a key. Its
  `SecretString` is a credential, and so is Vault AppRole's `secret_id`, a UUID.
- **A bare `key` or `token`** whose value doesn't read as a credential: one shorter than 16
  characters, or made of words and numbers, such as the lookup in `?key=checkout_v2`. `AIzaSy…`, a hex
  or base64 token or a JWT reads as one.

### Failures

[`--fail-at <call>=timeout` or `error`](./interventions.md#fail-a-tool) raises what the client
library raises for the real failure. A status comes back as that response.

| Client            | `timeout`                                           | `error`                   |
|-------------------|-----------------------------------------------------|---------------------------|
| `fetch`           | A `TimeoutError`                                    | `TypeError: fetch failed` |
| `http(s).request` | The request's own `timeout` event, then `ETIMEDOUT` | `ECONNRESET`              |
| httpx             | `ReadTimeout`                                       | `ReadError`               |
| urllib3           | `ReadTimeoutError`                                  | `ProtocolError`           |
| aiohttp           | `ServerTimeoutError`                                | `ClientOSError`           |

requests and botocore turn urllib3's errors into their own.

## API reference

The functions each SDK exports. In TypeScript they come from `@shadowlap/sdk`, in Python from
`shadowlap`.

| Function | What it does |
|---|---|
| `tool(name, { effect, onFork?, source?, trust? }, impl)` | Wraps a tool; returns a function with the same signature |
| `@tool(effect=…)` | Python: wraps a function, generator or callable object as a tool, with `name`, `on_fork`, `trust` and `exclude` |
| `now()` | The time in ms since the epoch, recorded and replayed |
| `random()` | A number in [0, 1), recorded and replayed |
| `uuid()` | A UUID, recorded and replayed |
| `scope(name, fn)` | Runs `fn` in a named [scope](#scopes); in Python, `with scope(name):` |
| `currentScope()` / `current_scope()` | The scope the code runs in |
| `userInput(prompt, read)` | Records what a person types; in Python `user_input()`, and `user_input_async()` for async reads |

The errors it throws:

| Error                        | When                                                             |
|------------------------------|------------------------------------------------------------------|
| `ShadowlapWriteBlocked`      | A `write` tool is called after a fork under `--writes block`     |
| `ReplayedError`              | A replay serves an error the tool threw while recording          |
| `ShadowlapInjectedFailure`   | `--fail-at` fails the tool; in Python, the base of the two below |
| `ShadowlapInjectedTimeout`   | Python: `--fail-at` times the tool out                           |
| `ShadowlapInjectedHTTPError` | Python: `--fail-at` answers with an HTTP status                  |

## Requirements

**TypeScript:**

- **Node ≥ 18.18,** as for any Node agent under shadowlap. `run`, `replay`, `test` and the commands
  that replay an agent load the guard and in-process capture into it through `--import` in
  `NODE_OPTIONS`. A Node before 18.18 refuses that, so the agent never starts, and the CLI says its
  Node is too old.
- **Zero dependencies.**
- **ES modules and CommonJS.** `@shadowlap/sdk` and `@shadowlap/adapters` are ES modules, and each
  ships a CommonJS copy beside them, which `require()` loads: a test runner with a module loader of
  its own, as Jest is, can't require an ES module on Node 22.
- **TypeScript resolution.** Their subpaths (`@shadowlap/adapters/ai-sdk`) resolve under TypeScript's
  `moduleResolution: node` too. Each package ships its TypeScript sources, so go-to-definition lands
  in them.
- **Edge runtimes and browsers.** The SDK runs in an Edge runtime (Vercel's, Cloudflare Workers) or a
  browser bundle as it is. It loads none of Node's modules until a call goes to shadowlap's sidecar,
  which only happens under shadowlap, so outside it a wrapped tool calls straight through wherever it
  is deployed.
- **Scopes on Node.** Node itself loads the package's `node` entry, which brings `AsyncLocalStorage`
  with it, so scopes hold on every Node it supports.

**Python:**

- **Python ≥ 3.9.** CI runs it on 3.9, 3.10, 3.13, 3.14 and the free-threaded 3.14t.
- **Zero dependencies** (`urllib`).
- **Typed.** The package is typed (`py.typed`), and passes mypy `--strict`, which CI checks.

**Versions.** Every call to the sidecar names the SDK and its release: `x-shadowlap-sdk: node/<version>`,
or `python/<version>` from Python. When its major.minor differs from the CLI's, the run's summary says
so once, with the install that matches.

## The wire protocol

Both SDKs are thin clients of one small HTTP API on the sidecar: `POST /v1/calls/resolve` before a
call, `POST /v1/calls/{callNo}/complete` after it. Model API calls need none of it: they are captured
through the provider's base URL, which works in any language already.

[The wire protocol](./protocol.md) specifies it completely, for writing an SDK in a language shadowlap
does not ship: discovery, headers, every response shape, scopes, errors, and what a client must do
when the sidecar is unreachable. A client that implements it should pass the conformance suite, which
runs against a real sidecar and needs no API keys.

## See also

- [Frameworks](./frameworks.md): declare effects through your framework's tools.
- [How it works](./how-it-works.md#effects): what each effect means for a replay.
- [Prompt injection](./injection.md): what `shadowlap injection` does with untrusted reads.
- [The wire protocol](./protocol.md): write an SDK for another language.
