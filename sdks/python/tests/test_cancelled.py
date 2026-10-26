"""A tool call the caller cancels (asyncio.wait_for's deadline, a task cancelled) is not the tool's
failure: it is recorded as cancelled, and its replay waits for the caller to cancel it again, so the
agent takes the path it took. The sidecar is stubbed; the vitest suite runs this file."""

import asyncio
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import shadowlap
from shadowlap import tool

try:
    import trio
except ImportError:  # the SDK needs neither; CI installs both for these tests
    trio = None

try:
    import anyio
except ImportError:
    anyio = None


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
                raise raised()  # noqa: B023 -- called in this iteration, before the loop moves on

            @tool(effect="write")
            async def asend(to: str) -> str:
                raise raised()  # noqa: B023 -- called in this iteration, before the loop moves on

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


class SlowSidecar(Sidecar):
    """Takes its time to answer a resolve, so the caller's cancel comes while the call is asked."""

    def __call__(self, cfg, path, body):
        if path.endswith("/resolve"):
            time.sleep(0.3)
        return super().__call__(cfg, path, body)


class CancelledWhileAsked(unittest.TestCase):
    """A cancel that comes while the sidecar is asked about a call: the call never runs, and is
    never left pending, under asyncio and trio alike."""

    def setUp(self):
        self._post = shadowlap._post
        os.environ["SHADOWLAP_URL"] = "http://sidecar.test"

    def tearDown(self):
        shadowlap._post = self._post
        os.environ.pop("SHADOWLAP_URL", None)

    def write_tool(self, ran):
        @tool(effect="write")
        async def send(to: str) -> str:
            ran.append(to)  # the write, before the tool's first await
            if _library() == "trio":
                await trio.sleep(0)
            else:
                await asyncio.sleep(0)
            return "sent"

        return send

    def test_under_asyncio_the_write_never_runs_and_the_call_ends_as_cancelled(self):
        sidecar = SlowSidecar({"origin": "live", "callNo": 5})
        shadowlap._post = sidecar
        ran = []
        send = self.write_tool(ran)

        async def main():
            try:
                return await asyncio.wait_for(send("ops"), timeout=0.05)
            except asyncio.TimeoutError:
                return "timed out"

        self.assertEqual(asyncio.run(main()), "timed out")
        self.assertEqual(ran, [])
        (body,) = completes(sidecar)
        self.assertEqual((body["outcome"], body["error"]["data"]), ("error", {"cancelled": True}))

    @unittest.skipUnless(trio, "trio is not installed")
    def test_under_trio_the_write_never_runs_and_the_call_ends_as_cancelled(self):
        sidecar = SlowSidecar({"origin": "live", "callNo": 5})
        shadowlap._post = sidecar
        ran = []
        send = self.write_tool(ran)

        async def main():
            with trio.move_on_after(0.05) as deadline:
                await send("ops")
            return deadline.cancelled_caught

        self.assertTrue(trio.run(main))
        self.assertEqual(ran, [])
        (body,) = completes(sidecar)
        self.assertEqual((body["outcome"], body["error"]["data"]), ("error", {"cancelled": True}))

    @unittest.skipUnless(anyio, "anyio is not installed")
    def test_under_anyio_on_asyncio_the_write_never_runs_and_the_wait_does_not_spin(self):
        sidecar = SlowSidecar({"origin": "live", "callNo": 5})
        shadowlap._post = sidecar
        ran = []
        send = self.write_tool(ran)
        # Each time the shield is awaited again: a cancelled anyio scope cancels the task at every
        # await, so waiting that out spun through it as fast as the loop could, until the answer came.
        shields = []
        real = asyncio.shield

        def counting(arg):
            shields.append(1)
            return real(arg)

        async def main():
            with anyio.move_on_after(0.05) as deadline:
                await send("ops")
            return deadline.cancelled_caught

        asyncio.shield = counting
        try:
            self.assertTrue(anyio.run(main, backend="asyncio"))
        finally:
            asyncio.shield = real
        self.assertEqual(ran, [])
        (body,) = completes(sidecar)
        self.assertEqual((body["outcome"], body["error"]["data"]), ("error", {"cancelled": True}))
        self.assertLess(len(shields), 10)

    @unittest.skipUnless(trio, "trio is not installed")
    def test_under_trio_a_stream_that_ends_in_a_cancelled_scope_is_still_ended(self):
        sidecar = Sidecar({"origin": "live", "callNo": 6})
        shadowlap._post = sidecar

        @tool(effect="read")
        async def pages():
            yield 1

        async def main():
            with trio.CancelScope() as scope:
                async for _ in pages():
                    scope.cancel()  # the stream ends with the scope already cancelled

        trio.run(main)
        (body,) = completes(sidecar)
        self.assertEqual((body["outcome"], body["result"]), ("ok", {"shadowlap_stream": [1]}))


def _library():
    return shadowlap._async_library()


if __name__ == "__main__":
    unittest.main()
