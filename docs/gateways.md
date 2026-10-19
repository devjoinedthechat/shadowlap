# Capturing production traffic

Shadowlap records by sitting in front of the agent, which suits a laptop and CI. In production
nobody re-points their agent at a dev tool — but plenty of teams already route model traffic through
a gateway, and a gateway is the same thing: something in the request path that sees the real bytes.

`shadowlap import litellm` reads what a [LiteLLM](https://docs.litellm.ai) proxy captured, so a run
that went wrong in production becomes a recording you can replay your own code against. Nothing
about the agent changes, and nothing about the proxy's behaviour changes.

## Setting it up

Put the callback in the proxy's configuration:

```yaml
litellm_settings:
  callbacks: shadowlap.litellm_callback.proxy_handler_instance
```

The `shadowlap` Python package must be importable by the proxy, and `SHADOWLAP_CAPTURE_DIR` must
name a directory to write into. With the variable unset the callback does nothing at all, which is
how you turn capture off without touching the config.

Then import what it wrote and replay:

```sh
shadowlap import litellm /var/log/shadowlap/*.jsonl
shadowlap replay <run> -- python agent.py
```

A proxy writes one file per worker process, so pass them all; `--json` lists what was imported and
what was skipped.

## Tag each run

A gateway serves every request the fleet makes, so one capture file interleaves calls from unrelated
runs. Without something to group them by, importing it produces a single run holding several
conversations at once — which replays against nothing.

So have the agent send a header that is the same for every call of one run, and different between
runs:

```python
client = OpenAI(base_url=GATEWAY, default_headers={"x-shadowlap-run": request_id})
```

`shadowlap import litellm` makes one run per value and shows the id beside each. `x-request-id`,
`x-correlation-id` and `x-trace-id` are read as fallbacks, and `SHADOWLAP_RUN_HEADER` names another
if yours is called something else. Calls carrying none are imported together, and the import says so.

## What a gateway capture is, and is not

The request captured is the one **the agent sent to the proxy**, not the one the proxy sent to the
provider. That is the right one: replay matches what the agent's own code produces, and to the agent
the proxy *is* the provider. Credentials are dropped before anything is written, and so are the
fields LiteLLM adds to the body on its way through.

An imported run is a [partial recording](./how-it-works.md#partial-recordings) like any other
import: a gateway sees model calls and nothing else, so a replay runs tool, clock and randomness
calls live rather than diverging on their absence, with writes still fenced by `--writes`. Its
cost is reported as captured, not spent, in `show`, the terminal UI and the dashboard: that traffic
was paid for in production, and importing it adds nothing to what your own runs spent.

Three things to expect:

- **A streamed call loses its chunking.** LiteLLM hands a callback an assembled response, so the original event boundaries are gone. It is re-serialized as a single event carrying the whole message: the agent's streaming code still runs and parses it, but it sees one chunk instead of many.
- **`stream_options` may need a normalizer.** LiteLLM adds it to a streamed request that did not carry it, and an agent asking for usage counts sends the same field, so a capture cannot tell them apart. If it turns out to be why a replay forks, `shadowlap calibrate` proposes the rule.
- **A top-level `metadata` field is lost.** LiteLLM overwrites it with its own bookkeeping.

## Which of it no golden covers

Once a week of traffic is in the store, [`shadowlap coverage`](./coverage.md) groups it by what
the agent did (the tools it called, the writes among them, how it ended) and names the behaviours
no golden covers. `--pack` replays one run of each with your agent's command, its own input filled
in where `{message}` stands, offline, its tool results taken from the capture, and keeps it as a
golden.

## Keeping the volume down

Everything the proxy serves is written, which is rarely what you want. Two things help, and both are
outside Shadowlap on purpose: point `SHADOWLAP_CAPTURE_DIR` at a directory with a short retention,
and set it only on the workers or the models you care about. A capture you keep for an hour is
enough to import the run someone just complained about.

## Another gateway

The callback is thin: it reads the inbound request and the response LiteLLM assembled, drops what
the gateway added, and writes one JSON object per line. `shadowlap.litellm_callback` is the LiteLLM
binding and `shadowlap._capture` is the part that decides what to keep, so a callback for a
different gateway is the binding again with the same body. The file format is whatever
`shadowlap import litellm` reads: `format: "shadowlap-capture"`, a URL, a method, headers, the
request body, the response as text, and the timing.
