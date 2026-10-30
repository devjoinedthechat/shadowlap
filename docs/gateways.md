# Capturing production traffic

`shadowlap import litellm` reads what a [LiteLLM](https://docs.litellm.ai) proxy captured, so a run
that went wrong in production becomes a recording you can replay your own code against. Nothing
about the agent changes, and nothing about the proxy's behaviour changes.

Shadowlap records by sitting in front of the agent, which suits a laptop and CI. In production
nobody re-points their agent at a dev tool. But plenty of teams already route model traffic through
a gateway, and a gateway is the same thing: something in the request path that sees the real bytes.

## Supported gateways

Each gateway writes capture files that `shadowlap import litellm` turns into runs.

| Gateway         | Captured by                                         | Notes                               |
|-----------------|-----------------------------------------------------|-------------------------------------|
| LiteLLM proxy   | `shadowlap.litellm_callback`, in the proxy's config | [Setting it up](#setting-it-up)     |
| Another gateway | A binding of your own over `shadowlap._capture`     | [Another gateway](#another-gateway) |

## Setting it up

1. Make the `shadowlap` Python package importable by the proxy.
2. Put the callback in the proxy's configuration:

   ```yaml
   litellm_settings:
     callbacks: shadowlap.litellm_callback.proxy_handler_instance
   ```

3. Set `SHADOWLAP_CAPTURE_DIR` to a directory to write into. With the variable unset, the callback
   does nothing at all, which is how you turn capture off without touching the config.
4. Import what it wrote, and replay:

   ```sh
   shadowlap import litellm /var/log/shadowlap/*.jsonl
   shadowlap replay <run> -- python agent.py
   ```

A proxy writes one file per worker process, so pass them all. `--json` lists what was imported and
what was skipped.

## Tag each run

A gateway serves every request the fleet makes, so one capture file interleaves calls from unrelated
runs. Without something to group them by, importing it produces a single run holding several
conversations at once, which replays against nothing.

So have the agent send a header that is the same for every call of one run, and different between
runs:

```python
client = OpenAI(base_url=GATEWAY, default_headers={"x-shadowlap-run": request_id})
```

`shadowlap import litellm` makes one run per value and shows the id beside each.

- **Fallbacks:** `x-request-id`, `x-correlation-id` and `x-trace-id` are read when `x-shadowlap-run`
  is missing.
- **Another header:** `SHADOWLAP_RUN_HEADER` names it, if yours is called something else.
- **No header:** calls carrying none are imported together, and the import says so.

## What a gateway capture is, and is not

The request captured is the one **the agent sent to the proxy**, not the one the proxy sent to the
provider. That is the right one: replay matches what the agent's own code produces, and to the agent
the proxy *is* the provider.

What a capture keeps of a request:

- **Credential headers** (`authorization`, `x-api-key`, `api-key`, cookies, `x-goog-api-key`,
  `x-amz-security-token`) are dropped before anything is written.
- **The fields LiteLLM adds to the body** on its way through are dropped too.
- **Headers:** the import keeps only those that change what the model does.
- **The query** is kept without credentials.

An imported run is a [partial recording](./how-it-works.md#partial-recordings), like any other
import. A gateway sees model calls and nothing else, so a replay runs tool, clock and randomness
calls live rather than diverging on their absence, with writes still fenced by `--writes`.

Its cost is reported as captured, not spent, in `show`, the terminal UI and the dashboard. That
traffic was paid for in production, and importing it adds nothing to what your own runs spent.

Three things to expect:

- **A streamed call loses its chunking.** LiteLLM hands a callback an assembled response, so the
  original event boundaries are gone. It is re-serialized as a single event carrying the whole
  message: the agent's streaming code still runs and parses it, but it sees one chunk instead of many.
- **`stream_options` may need a normalizer.** LiteLLM adds it to a streamed request that did not
  carry it, and an agent asking for usage counts sends the same field, so a capture cannot tell them
  apart. If it turns out to be why a replay forks, `shadowlap calibrate` proposes the rule.
- **A top-level `metadata` field is lost.** LiteLLM overwrites it with its own bookkeeping.

## Which of it no golden covers

Once a week of traffic is in the store, [`shadowlap coverage`](./coverage.md) groups it by what the
agent did (the tools it called, the writes among them, how it ended). It names the behaviours no
golden covers.

`--pack` replays one run of each with your agent's command, and keeps it as a golden. The replay:

- fills in the run's own input where `{message}` stands;
- runs offline, its tool results taken from the capture.

## Keeping the volume down

Everything the proxy serves is written, which is rarely what you want. Two things help, and both are
outside Shadowlap on purpose:

- Point `SHADOWLAP_CAPTURE_DIR` at a directory with a short retention.
- Set it only on the workers or the models you care about.

A capture you keep for an hour is enough to import the run someone just complained about.

## Another gateway

The callback is thin. It reads the inbound request and the response LiteLLM assembled, drops what
the gateway added, and writes one JSON object per line. It has two parts:

| Module                       | Role                               |
|------------------------------|------------------------------------|
| `shadowlap.litellm_callback` | The LiteLLM binding                |
| `shadowlap._capture`         | The part that decides what to keep |

So a callback for a different gateway is the binding again, with the same body. The file format is
whatever `shadowlap import litellm` reads. Each line holds:

- `format: "shadowlap-capture"`;
- a URL and a method;
- headers;
- the request body;
- the response as text;
- the timing.

## See also

- [`shadowlap import`](./cli.md#import): every format the import reads, and its flags.
- [Production coverage](./coverage.md): the behaviours no golden covers.
- [Partial recordings](./how-it-works.md#partial-recordings): how a replay treats calls a capture lacks.
