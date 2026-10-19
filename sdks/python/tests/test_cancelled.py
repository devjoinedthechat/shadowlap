"""A tool call the caller cancels (asyncio.wait_for's deadline, a task cancelled) is not the tool's
failure: it is recorded as cancelled, and its replay waits for the caller to cancel it again, so the
agent takes the path it took. The sidecar is stubbed; the vitest suite runs this file."""

import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import shadowlap  # noqa: E402
from shadowlap import tool  # noqa: E402


class Sidecar:
    def __init__(self, decision):
        self.decision = decision
        self.sent = []

    def __call__(self, cfg, path, body):
        json.dumps(body, allow_nan=False)
        self.sent.append((path, body))
        return dict(self.decision) if path.endswith("/resolve") else {}


def completes(sidecar):
    return [body for path, body in sidecar.sent if path.endswith("/complete")]


class Cancelled(unittest.TestCase):
    def setUp(self):
        self._post = shadowlap._post
        os.environ["SHADOWLAP_URL"] = "http://sidecar.test"

    def tearDown(self):
        shadowlap._post = self._post
        os.environ.pop("SHADOWLAP_URL", None)

    def agent(self, ran):
        @tool(effect="read")
        async def slow_search(query: str) -> dict:
            ran.append(query)
            await asyncio.sleep(5)
            return {"hits": [query]}

        async def main():
            try:
                return await asyncio.wait_for(slow_search("refunds"), timeout=0.05)
            except asyncio.TimeoutError:
                return {"answer": "search timed out; answering without it"}

        return main

    def test_a_call_cut_off_by_its_deadline_is_recorded_as_cancelled(self):
        sidecar = Sidecar({"origin": "live", "callNo": 1})
        shadowlap._post = sidecar
        ran = []
        self.assertEqual(asyncio.run(self.agent(ran)()), {"answer": "search timed out; answering without it"})
        self.assertEqual(ran, ["refunds"])
        (body,) = completes(sidecar)
        self.assertEqual(body["outcome"], "error")
        self.assertEqual(body["error"]["name"], "CancelledError")
        self.assertEqual(body["error"]["data"], {"cancelled": True})

    def test_its_replay_waits_for_the_deadline_again_instead_of_raising(self):
        for error in (
            {"name": "CancelledError", "message": "", "data": {"cancelled": True}},
            # Recorded before cancellations were marked: the name alone says it.
            {"name": "CancelledError", "message": ""},
        ):
            sidecar = Sidecar({"origin": "replayed", "callNo": 1, "outcome": "error", "error": error})
            shadowlap._post = sidecar
            ran = []
            self.assertEqual(asyncio.run(self.agent(ran)()), {"answer": "search timed out; answering without it"})
            self.assertEqual(ran, [])
            self.assertEqual(completes(sidecar), [])

    def test_a_cancelled_error_the_tool_raised_itself_is_raised_again_as_one(self):
        sidecar = Sidecar({"origin": "live", "callNo": 2})
        shadowlap._post = sidecar

        @tool(effect="read")
        async def fetch(url: str) -> str:
            inner = asyncio.ensure_future(asyncio.sleep(5))
            inner.cancel()
            return await inner  # the tool's own awaitable was cancelled, not the call

        async def main():
            try:
                await fetch("https://example.com")
            except asyncio.CancelledError:
                return "cancelled"

        if sys.version_info >= (3, 11):  # before 3.11 a task can't tell who cancelled it
            self.assertEqual(asyncio.run(main()), "cancelled")
            (body,) = completes(sidecar)
            self.assertEqual(body["error"]["data"], {"cancelled": False})
            shadowlap._post = Sidecar({"origin": "replayed", "callNo": 2, "outcome": "error", "error": body["error"]})
            self.assertEqual(asyncio.run(main()), "cancelled")

    def test_an_interrupt_or_exit_inside_a_tool_is_not_recorded_as_its_error(self):
        for raised in (KeyboardInterrupt, SystemExit):
            sidecar = Sidecar({"origin": "live", "callNo": 3})
            shadowlap._post = sidecar

            @tool(effect="write")
            def send(to: str) -> str:
                raise raised()

            @tool(effect="write")
            async def asend(to: str) -> str:
                raise raised()

            with self.assertRaises(raised):
                send("ops")
            with self.assertRaises(raised):
                asyncio.run(asend("ops"))
            self.assertEqual(completes(sidecar), [])

    def test_user_input_cut_off_by_its_deadline_replays_the_same_way(self):
        sidecar = Sidecar({"origin": "live", "callNo": 4})
        shadowlap._post = sidecar

        async def never_answers(prompt):
            await asyncio.sleep(5)
            return "too late"

        async def main():
            try:
                return await asyncio.wait_for(shadowlap.user_input_async("Approve?", never_answers), timeout=0.05)
            except asyncio.TimeoutError:
                return "no answer"

        self.assertEqual(asyncio.run(main()), "no answer")
        (body,) = completes(sidecar)
        self.assertEqual(body["error"]["data"], {"cancelled": True})
        shadowlap._post = Sidecar({"origin": "replayed", "callNo": 4, "outcome": "error", "error": body["error"]})
        self.assertEqual(asyncio.run(main()), "no answer")


if __name__ == "__main__":
    unittest.main()
