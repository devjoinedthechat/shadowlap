# Agents across services

An agent that calls another service over HTTP, such as a pricing service, a policy engine or another team's agent behind an endpoint, is recorded where `shadowlap run` started it: in the agent. The service runs in a process of its own, so its own model and tool calls go unrecorded. What it answered can still be recorded. Declare its host, and every call the agent makes to it is recorded as a tool call, so a replay serves the service's answers from the recording, whether or not the service is running.

## Declare the service

In `shadowlap.config.json`, name its host and what a call to it does:

```json
{
  "http": {
    "pricing.internal.example.com": "read",
    "refunds.internal.example.com:8443": "write"
  }
}
```

| Effect | For a service that | Before a fork | After a fork |
|---|---|---|---|
| `read` | Answers and changes nothing: a quote, a lookup, an agent that only advises | Served from the recording | Called live |
| `write` | Acts: opens a ticket, moves money, sends a message | Served from the recording | Never called: the agent gets HTTP 409, or with `--writes stub` a 200 whose body is `{"shadowlap":"stubbed"}` |
| `pure` | Always answers the same request the same way | Served from the recording | Served when the recording holds the same request, called live otherwise |

A host takes one effect for every call to it, so a service that answers some calls and acts on others is a `write`: a replay never does again what it did. A host is a name like `api.example.com`, or `*.example.com` for any of its subdomains, with an optional `:port`, over `http` or `https`.

In Node and Python agents the calls are captured in the process, whatever client makes them: `fetch` and `http(s)` in Node, and httpx, requests, botocore, urllib3 and aiohttp in Python ([in-process capture](./providers.md#in-process-capture)). An agent in another language wraps its calls to the service as a tool, through its SDK or [the wire protocol](./protocol.md).

## What the recording holds

Each call is a tool call named after its method, host and path, such as `POST pricing.internal.example.com/v1/quote`: the request's method, URL and body are its arguments, and the response's status, headers and body its result ([the recording format](./recording-format.md#blobs)). `shadowlap show <run>` lists them with the run's other calls.

Request headers are never stored, so a token the agent sends to the service stays out of the recording, and a credential in a query string or a form body is stored as `<CREDENTIAL>` ([HTTP services](./sdk.md#http-services-without-wrapping) has the rules). Headers take no part in matching either: a trace header the agent sends with every call, such as `traceparent`, changes nothing.

## Replaying without the service

Before a fork, every call to the service is served from the recording, with the bytes the service sent, and the service is never called. A golden of the agent therefore replays in CI where the service isn't deployed at all:

```sh
shadowlap test goldens/*
```

After a fork, `read` calls go to the service live, so it has to be reachable then; `write` calls never do.

## Values the agent makes up per call

A call to the service is matched like any other call: exactly, after [normalizers](./normalizers-and-redaction.md). A request id or a timestamp the agent puts in the body of every call forks the replay at the first one. Mask it with a normalizer scoped to the call, its path starting at the call's arguments:

```sh
shadowlap normalize add --kind tool --name 'POST pricing.internal.example.com/v1/quote' --path '$.args.body.request_id' --replace '<id>'
```

## When the change is in the service

A replay serves the service's recorded answers, so it tests the agent against the service as it was. To try the agent against the service as it is now, run the calls to it live: `--live-tool` takes the call's name, and the replay forks at the first call to it, with writes fenced from there as after any fork.

```sh
shadowlap replay <run> --live-tool 'POST pricing.internal.example.com/v1/quote'
```

To see what the agent does when the service fails or answers otherwise, answer for it, without calling it:

- `shadowlap replay <run> --fail-at <call>=503` answers the call with that status, and `--fail-at <call>=timeout` times it out the way the agent's HTTP client reports a real timeout ([failures](./interventions.md#fail-a-tool)).
- `shadowlap replay <run> --override <call>='{"total": 0}'` answers it with that JSON body.

## What isn't recorded

- **The service's own calls.** Its model calls and tools run inside it, so a change to its prompt shows only as different answers. To replay the service itself, record it on its own, with `shadowlap run` around its process; that is a run of its own, apart from the agent's.
- **A stream from the service** is buffered, so the agent gets it whole.
- **A host nobody declared** is not recorded: the [network guard](./how-it-works.md#the-network-guard) names it during the run, and `shadowlap test` blocks the connection.
