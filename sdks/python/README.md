# Shadowlap SDK for Python

Wrap your agent's tools once with their effect, so [Shadowlap](https://github.com/devjoinedthechat/shadowlap) records every call and a replay serves it from the recording instead of running it again.

```sh
pip install shadowlap
```

```python
from shadowlap import tool

@tool(effect="read")
def lookup_order(order_id: str) -> dict:
    return orders.get(order_id)

@tool(effect="write")
def issue_refund(order_id: str, amount: float) -> dict:
    return payments.refund(order_id, amount)
```

Record and replay with the `shadowlap` command, which this package installs: it runs the Shadowlap CLI from npm at the package's own version (an npm install of that version on your `PATH`, or `npx`), so it needs Node.js 22.16 or later, not 23, and says how to get it when there is none.

```sh
shadowlap run -- python agent.py    # record a run, with your usual key
shadowlap replay <run>              # a clean replay: 0 upstream requests, no real key
```

Model calls need no code changes: `shadowlap run` routes the Anthropic, OpenAI and Gemini SDKs through its sidecar, and captures Azure OpenAI, Gemini Enterprise Agent Platform (Vertex AI) and Bedrock clients inside the process. Outside Shadowlap every wrapper is a passthrough, so decorated tools ship unchanged.

- `effect` is required: `pure` (depends only on its arguments), `read` (reads outside state) or `write` (changes it). After a fork, `read` tools run live and a `write` raises `ShadowlapWriteBlocked`, unless the replay stubs writes, returning what `on_fork` gives, or allows them. Coroutine functions, async generators (a streaming tool keeps streaming) and objects with an async `__call__` work too, under asyncio, trio and anyio.
- `now()`, `random()` and `uuid()` record the clock and randomness, so a replay sees the values the run saw.
- `scope()` names branches of the agent that run at once, `user_input()` records what a person types, and `trust="untrusted"` marks a read for injection tests.
- A tool that a replay's `--fail-at` fails raises without running: `ShadowlapInjectedTimeout`, a `TimeoutError`, or `ShadowlapInjectedHTTPError` with the status.
- Parameters a framework injects, such as a Pydantic AI `RunContext` or a LangChain config, are left out of the recording. `shadowlap.adapters` has adapters for the OpenAI Agents SDK, LangChain and LangGraph, CrewAI and Google ADK, and fences the Claude Agent SDK's built-in tools through its hooks. Pydantic AI, LlamaIndex, Microsoft Agent Framework, Strands, smolagents and Agno need none: wrap the function they take with `@tool`.

## Recorded tests

Mark a pytest test, and it records its model and tool calls on its first run, then replays them offline:

```python
import pytest

@pytest.mark.shadowlap
def test_escalates_a_refund_above_the_limit(shadowlap_recording):
    refund_agent("A-1042")
    assert shadowlap_recording.called("escalate") == 1
    assert shadowlap_recording.called("issue_refund") == 0
```

The `shadowlap_recording` fixture tells what the agent did: `called(name, **args)`, `tool_calls(name=None)`, `calls()` and `answer()`. Recordings go to `__recordings__/` beside the test; commit them. `SHADOWLAP_RECORD=all` records again, and `none`, the default when `CI` is set, only replays. Other test runners use `with shadowlap.testing.recording(path):`. The plugin runs the `shadowlap` command on your `PATH`, which this package provides, or the one `SHADOWLAP_CLI` names.

Python 3.9 or later, no dependencies. The package is typed (`py.typed`) and passes mypy `--strict`.

[SDKs](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/sdk.md) · [Frameworks](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/frameworks.md#python) · [Test suites](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/testing.md)
