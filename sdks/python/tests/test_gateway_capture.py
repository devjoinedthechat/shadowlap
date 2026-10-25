"""What a gateway capture keeps, and in what shape.

These are the decisions that only real LiteLLM traffic revealed: which fields the gateway added to
the request it forwards, how a streamed response survives being handed over already assembled, and
what must never reach disk. The vitest suite runs this file; `shadowlap._capture` deliberately
imports nothing from LiteLLM so it can be tested without it.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from shadowlap._capture import _agent_body, _headers, _response_text, _run_key

ESC = chr(27)


class Response:
    """Stands in for LiteLLM's ModelResponse, which the callback reads through model_dump()."""

    def __init__(self, payload):
        self._payload = payload

    def model_dump(self):
        return self._payload


CHAT = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "model": "gpt-4.1-mini",
    "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}],
    "usage": {"prompt_tokens": 42, "completion_tokens": 7},
}


class AgentBody(unittest.TestCase):
    def test_litellm_namespaced_fields_are_dropped(self):
        # litellm_call_id is unique per request: a recording that kept it would not match itself.
        body = {
            "model": "gpt-4.1-mini",
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 64,
            "litellm_call_id": "b13b7c5b-e4a5-4ffc-b9e1-536ba5335927",
            "_litellm_strip_stream_usage": True,
            "metadata": {"user_api_key_hash": "9df3"},
        }
        self.assertEqual(_agent_body(body), {"model": "gpt-4.1-mini", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 64})

    def test_stream_options_is_kept_because_an_agent_may_have_sent_it(self):
        # LiteLLM adds it to a streamed request that lacked it, and an agent asking for usage counts
        # sends exactly the same field. Dropping it would be wrong for that agent; calibrate
        # proposes the normalizer when it turns out to be why a replay forked.
        body = {"model": "m", "stream": True, "stream_options": {"include_usage": True}}
        self.assertEqual(_agent_body(body), body)

    def test_an_empty_body_stays_empty(self):
        self.assertEqual(_agent_body({}), {})


class Headers(unittest.TestCase):
    def test_credentials_never_reach_disk(self):
        kept = _headers({"Authorization": "Bearer sk-secret", "X-Api-Key": "sk-also-secret", "Content-Type": "application/json"})
        self.assertEqual(kept, {"content-type": "application/json"})
        self.assertNotIn("secret", json.dumps(kept))

    def test_names_are_lowercased_and_values_stringified(self):
        self.assertEqual(_headers({"OpenAI-Beta": "assistants=v2", "Content-Length": 96}), {"openai-beta": "assistants=v2", "content-length": "96"})

    def test_anything_that_is_not_a_mapping_is_no_headers(self):
        self.assertEqual(_headers(None), {})
        self.assertEqual(_headers("x"), {})


class RunKey(unittest.TestCase):
    def setUp(self):
        os.environ.pop("SHADOWLAP_RUN_HEADER", None)

    tearDown = setUp

    def test_shadowlap_header_wins_over_the_generic_ones(self):
        self.assertEqual(_run_key({"x-request-id": "req-1", "x-shadowlap-run": "incident-42"}), "incident-42")

    def test_generic_headers_are_a_fallback_in_order(self):
        self.assertEqual(_run_key({"x-correlation-id": "c", "x-request-id": "r"}), "r")
        self.assertEqual(_run_key({"x-trace-id": "t"}), "t")

    def test_a_named_header_takes_precedence(self):
        os.environ["SHADOWLAP_RUN_HEADER"] = "X-Session"
        self.assertEqual(_run_key({"x-session": "s-9", "x-shadowlap-run": "other"}), "s-9")

    def test_no_header_means_no_key(self):
        self.assertIsNone(_run_key({"content-type": "application/json"}))
        self.assertIsNone(_run_key({"x-shadowlap-run": "   "}))

    def test_a_value_that_would_not_be_safe_to_display_is_refused(self):
        # It becomes a label on the run it groups, so it is held to the same bar as one.
        self.assertIsNone(_run_key({"x-shadowlap-run": "a" + ESC + "[2Jb"}))
        self.assertIsNone(_run_key({"x-shadowlap-run": "x" * 201}))


class ResponseShape(unittest.TestCase):
    def test_a_plain_call_is_recorded_as_its_json(self):
        self.assertEqual(json.loads(_response_text(Response(CHAT), streamed=False)), CHAT)

    def test_a_streamed_call_is_re_serialized_as_one_event(self):
        # LiteLLM hands over an assembled response, so the original boundaries are gone. The agent's
        # client still has to be able to parse what it gets, which means event-stream framing.
        text = _response_text(Response(CHAT), streamed=True)
        self.assertTrue(text.endswith("data: [DONE]" + chr(10) + chr(10)))
        events = [part[len("data: "):] for part in text.split(chr(10) + chr(10)) if part.startswith("data: ")]
        self.assertEqual(len(events), 2)
        chunk = json.loads(events[0])
        self.assertEqual(chunk["object"], "chat.completion.chunk")
        # A chunk carries `delta`, not `message`, or a streaming client ignores the content.
        self.assertEqual(chunk["choices"][0]["delta"], {"role": "assistant", "content": "ok"})
        self.assertNotIn("message", chunk["choices"][0])

    def test_something_with_no_payload_is_not_invented(self):
        self.assertIsNone(_response_text(Response("not a mapping"), streamed=False))


if __name__ == "__main__":
    unittest.main()
