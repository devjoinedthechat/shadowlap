# shadowlap (Python SDK)

The Python client for [Shadowlap](https://github.com/devjoinedthechat/shadowlap). API calls are captured by the sidecar with no code changes (the Anthropic SDK reads `ANTHROPIC_BASE_URL`); this package wraps tools so Shadowlap knows what they do to the world, and records clock and randomness.

```python
from shadowlap import tool, now, uuid, ShadowlapWriteBlocked

@tool(effect="read")
def search_web(query: str) -> dict:
    return {"results": search(query)}

@tool(effect="pure")
def read_file(path: str) -> str:
    return FILES[path]

@tool(effect="write", on_fork=lambda to, subject, body: {"sent": False, "suppressed": True})
def send_email(to: str, subject: str, body: str) -> dict:
    return mailer.send(to, subject, body)

started_at = now()      # recorded; a replay sees the same value
request_id = uuid()
```

`effect` is required: `pure` (depends only on the arguments), `read` (touches outside state) or `write` (changes it). `async def` tools are supported. Without `SHADOWLAP_URL` in the environment every wrapper is a passthrough, so decorated tools ship to production unchanged. Zero dependencies.

Parameters a framework injects, such as a Pydantic AI `RunContext` or a LangChain config, are left out of the recorded arguments automatically; `exclude=(...)` names any others. Adapters for the OpenAI Agents SDK, LangChain/LangGraph and CrewAI are in `shadowlap.adapters`:

```python
from shadowlap.adapters.openai_agents import function_tool   # @function_tool(effect="read")
from shadowlap.adapters.langchain import with_effect          # with_effect(tool, "read")
from shadowlap.adapters.crewai import with_effect             # with_effect(tool, "write")
```

## Recorded tests

With pytest, mark a test and it records its model and tool calls on the first run, then replays them offline:

```python
@pytest.mark.shadowlap
def test_triage(shadowlap_recording):
    assert len(run_agent("triage the inbox").tickets) == 3
    assert shadowlap_recording.called("send_email") == 0
```

The `shadowlap_recording` fixture tells what the agent did during the test: `called(name, **args)`, `tool_calls(name=None)`, `calls()` and `answer()`.

Recordings go to `__recordings__/` beside the test; commit them. `SHADOWLAP_RECORD=all` records again, and `none` (the default when `CI` is set) only replays. Other test runners can use `with shadowlap.testing.recording("path"):`. It needs the `shadowlap` CLI from npm. See [Test suites](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/testing.md).
