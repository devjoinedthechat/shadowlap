"""shadowlap.user_input(): a person's answer, recorded as a user_input call that a replay serves.
The sidecar is stubbed; the vitest suite drives the preload that records input() end to end."""

import asyncio
import contextlib
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import shadowlap  # noqa: E402
from shadowlap import user_input, user_input_async  # noqa: E402


class Sidecar:
    """Answers resolve with a fixed decision and keeps what the SDK sent."""

    def __init__(self, decision):
        self.decision = decision
        self.sent = []

    def __call__(self, cfg, path, body):
        self.sent.append((path, body))
        return dict(self.decision) if path.endswith("/resolve") else {}


class UserInput(unittest.TestCase):
    def setUp(self):
        self._post = shadowlap._post
        os.environ["SHADOWLAP_URL"] = "http://sidecar.test"

    def tearDown(self):
        shadowlap._post = self._post
        os.environ.pop("SHADOWLAP_URL", None)
        sys.modules.pop("_shadowlap_input", None)

    def test_outside_shadowlap_it_only_reads(self):
        os.environ.pop("SHADOWLAP_URL")
        self.assertEqual(user_input("Order? ", read=lambda p: "asked " + p), "asked Order? ")

    def test_a_live_answer_is_recorded_with_its_prompt(self):
        sidecar = Sidecar({"origin": "live", "callNo": 4})
        shadowlap._post = sidecar
        self.assertEqual(user_input("Order? ", read=lambda p: "A-1042"), "A-1042")
        resolve, complete = sidecar.sent
        self.assertEqual(resolve, ("/v1/calls/resolve", {"kind": "tool", "name": "user_input", "effect": "read", "args": {"prompt": "Order? "}, "input": True}))
        self.assertEqual(complete[0], "/v1/calls/4/complete")
        self.assertEqual(complete[1]["result"], {"text": "A-1042"})

    def test_a_replay_serves_the_recorded_answer_without_asking(self):
        shadowlap._post = Sidecar({"origin": "replayed", "callNo": 1, "outcome": "ok", "result": {"text": "A-1042"}})

        def nobody(prompt):
            raise AssertionError("no one is there to answer")

        self.assertEqual(user_input("Order? ", read=nobody), "A-1042")
        # An answer given differently may be plain text.
        shadowlap._post = Sidecar({"origin": "replayed", "callNo": 1, "outcome": "ok", "result": "B-7"})
        self.assertEqual(user_input("Order? ", read=nobody), "B-7")

    def test_the_recorded_end_of_the_input_is_raised_as_it_was(self):
        shadowlap._post = Sidecar({"origin": "replayed", "callNo": 1, "outcome": "error", "error": {"name": "EOFError", "message": "end of input"}})
        with self.assertRaises(EOFError):
            user_input("Order? ")

    def test_a_failed_read_is_recorded_as_an_error(self):
        sidecar = Sidecar({"origin": "live", "callNo": 2})
        shadowlap._post = sidecar

        def closed(prompt):
            raise ConnectionError("the chat window was closed")

        with self.assertRaises(ConnectionError):
            user_input("Order? ", read=closed)
        self.assertEqual(sidecar.sent[1][1]["error"], {"name": "ConnectionError", "message": "the chat window was closed"})

    def test_with_the_preload_loaded_the_answer_is_read_unrecorded_inside_and_recorded_once(self):
        entered = []

        @contextlib.contextmanager
        def passthrough():
            entered.append(True)
            yield

        sys.modules["_shadowlap_input"] = types.SimpleNamespace(active=True, passthrough=passthrough, original_input=lambda p: "typed")
        shadowlap._post = Sidecar({"origin": "live", "callNo": 1})
        self.assertEqual(user_input("Order? "), "typed")
        self.assertEqual(entered, [True])

    def test_an_asyncio_agent_awaits_its_reader(self):
        sidecar = Sidecar({"origin": "live", "callNo": 3})
        shadowlap._post = sidecar

        async def from_socket(prompt):
            await asyncio.sleep(0)
            return "over the socket"

        self.assertEqual(asyncio.run(user_input_async("Order? ", from_socket)), "over the socket")
        self.assertEqual(sidecar.sent[1][1]["result"], {"text": "over the socket"})


if __name__ == "__main__":
    unittest.main()
