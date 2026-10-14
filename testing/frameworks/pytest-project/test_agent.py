"""A test suite for an agent, as a user would write it: the model client is created at import, before
Shadowlap starts, and one tool goes through the Shadowlap SDK. Run by pytest-plugin.test.mjs."""

import os

import anthropic
import pytest

from shadowlap import tool

client = anthropic.Anthropic(api_key="test-key", max_retries=0)
TOOL_LOG = os.environ.get("TOOL_LOG", os.devnull)


@tool(effect="read")
def lookup(topic: str) -> str:
    with open(TOOL_LOG, "a") as f:
        f.write(topic + "\n")
    return "notes about " + topic


def ask(prompt: str) -> str:
    notes = lookup(prompt)
    reply = client.messages.create(model="claude-opus-5", max_tokens=64, messages=[{"role": "user", "content": prompt + " / " + notes}])
    return reply.content[0].text


@pytest.mark.shadowlap
def test_triage():
    assert ask(os.environ.get("PROMPT", "hello")).startswith("echo: ")


@pytest.mark.shadowlap
@pytest.mark.parametrize("n", [1, 2])
def test_parametrized(n, shadowlap_recording):
    assert ask("item %d" % n) == "echo: item %d / notes about item %d" % (n, n)
    # What the agent did, the same whether the test records or replays.
    rec = shadowlap_recording
    assert rec.called("lookup") == 1
    assert rec.called("lookup", topic="item %d" % n) == 1
    assert rec.called("lookup", topic="other") == 0
    assert rec.answer() == "echo: item %d / notes about item %d" % (n, n)
    lookup_call, model_call = rec.calls()
    assert lookup_call["args"] == {"topic": "item %d" % n}
    assert lookup_call["result"] == "notes about item %d" % n
    assert lookup_call["origin"] == ("live" if rec.action == "record" else "replayed")
    assert (model_call["kind"], model_call["model"], model_call["outcome"]) == ("api", "claude-opus-5", "ok")


@pytest.mark.shadowlap
def test_fails_while_recording():
    ask("broken")
    assert os.environ.get("MAKE_IT_PASS") == "1"


def test_without_the_marker():
    assert True
