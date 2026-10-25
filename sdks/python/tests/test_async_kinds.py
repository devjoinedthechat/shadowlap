"""Every kind of async tool under Shadowlap, not only coroutine functions: an async generator function
streams as it does outside Shadowlap and records its last value, an object with an async __call__
stays awaitable, and all of them run under trio and anyio as under asyncio. The sidecar is stubbed,
except where the header the SDK sends is the point."""

import asyncio
import http.server
import inspect
import json
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import shadowlap
from shadowlap import ShadowlapWriteBlocked, tool

try:
    import trio
except ImportError:  # the SDK needs neither; CI installs both for these tests
    trio = None
try:
    import anyio
except ImportError:
    anyio = None


class Sidecar:
    """Answers resolve with a fixed decision and keeps what the SDK sent."""

    def __init__(self, decision):
        self.decision = decision
        self.sent = []

    def __call__(self, cfg, path, body):
        json.dumps(body, allow_nan=False)
        self.sent.append((path, body))
        return dict(self.decision) if path.endswith("/resolve") else {}

    def completes(self):
        return [body for path, body in self.sent if path.endswith("/complete")]


class Stubbed(unittest.TestCase):
    def setUp(self):
        self._post = shadowlap._post
        os.environ["SHADOWLAP_URL"] = "http://sidecar.test"

    def tearDown(self):
        shadowlap._post = self._post
        os.environ.pop("SHADOWLAP_URL", None)

    def use(self, decision):
        sidecar = Sidecar(decision)
        shadowlap._post = sidecar
        return sidecar


def progress_tool(ran):
    @tool(effect="read")
    async def search(query: str, pages: int = 3):
        ran.append(query)
        for i in range(pages):
            await asyncio.sleep(0)
            yield {"page": i + 1, "of": pages, "query": query}

    return search


async def collect(stream):
    return [value async for value in stream]


class AsyncGenerators(Stubbed):
    def test_it_stays_an_async_generator_function(self):
        search = progress_tool([])
        self.assertTrue(inspect.isasyncgenfunction(search))
        self.assertEqual(search.__name__, "search")

    def test_recording_streams_each_value_and_records_the_last(self):
        sidecar = self.use({"origin": "live", "callNo": 4})
        ran = []
        values = asyncio.run(collect(progress_tool(ran)("refunds")))
        self.assertEqual([v["page"] for v in values], [1, 2, 3])
        self.assertEqual(ran, ["refunds"])
        resolve = sidecar.sent[0][1]
        self.assertEqual((resolve["name"], resolve["effect"], resolve["args"]), ("search", "read", {"query": "refunds", "pages": 3}))
        [done] = sidecar.completes()
        self.assertEqual((done["outcome"], done["result"]), ("ok", {"page": 3, "of": 3, "query": "refunds"}))

    def test_a_replay_yields_the_recorded_value_alone_and_runs_nothing(self):
        self.use({"origin": "replayed", "callNo": 4, "outcome": "ok", "result": {"page": 3, "of": 3}})
        ran = []
        self.assertEqual(asyncio.run(collect(progress_tool(ran)("refunds"))), [{"page": 3, "of": 3}])
        self.assertEqual(ran, [])

    def test_a_reader_that_stops_early_stops_the_tool_and_records_what_it_read(self):
        sidecar = self.use({"origin": "live", "callNo": 4})
        closed = []

        @tool(effect="read")
        async def watch(topic: str):
            try:
                for i in range(100):
                    yield i
            finally:
                closed.append(topic)

        async def first_two():
            stream = watch("orders")
            got = [await stream.__anext__(), await stream.__anext__()]
            await stream.aclose()
            return got

        self.assertEqual(asyncio.run(first_two()), [0, 1])
        self.assertEqual(closed, ["orders"])
        [done] = sidecar.completes()
        self.assertEqual((done["outcome"], done["result"]), ("ok", 1))

    def test_a_failure_of_the_tool_is_recorded_as_its_error_and_raised(self):
        sidecar = self.use({"origin": "live", "callNo": 4})

        @tool(effect="read")
        async def flaky(n: int):
            yield 1
            raise KeyError("A-17")

        with self.assertRaises(KeyError):
            asyncio.run(collect(flaky(1)))
        [done] = sidecar.completes()
        self.assertEqual((done["outcome"], done["error"]["name"]), ("error", "KeyError"))

    def test_sent_values_and_thrown_errors_reach_the_tool(self):
        self.use({"origin": "live", "callNo": 4})
        seen = []

        @tool(effect="pure")
        async def echo(start: int):
            value = start
            while True:
                try:
                    got = yield value
                except ValueError as err:
                    seen.append(str(err))
                    got = -1
                value = got

        async def drive():
            stream = echo(1)
            out = [await stream.__anext__(), await stream.asend(5), await stream.athrow(ValueError("nope"))]
            await stream.aclose()
            return out

        self.assertEqual(asyncio.run(drive()), [1, 5, -1])
        self.assertEqual(seen, ["nope"])

    def test_a_blocked_write_raises_before_the_tool_runs(self):
        self.use({"origin": "blocked", "callNo": 4, "outcome": "error", "error": {"name": "ShadowlapWriteBlocked", "message": "write tool send blocked after divergence"}})
        ran = []

        @tool(effect="write")
        async def send(to: str):
            ran.append(to)
            yield "sent"

        with self.assertRaises(ShadowlapWriteBlocked):
            asyncio.run(collect(send("team@example.com")))
        self.assertEqual(ran, [])

    def test_a_stubbed_write_yields_on_fork_and_records_it(self):
        sidecar = self.use({"origin": "stubbed", "callNo": 4})

        @tool(effect="write", on_fork=lambda to: {"sent": False})
        async def send(to: str):
            yield "sent"

        self.assertEqual(asyncio.run(collect(send("team@example.com"))), [{"sent": False}])
        self.assertEqual(sidecar.completes()[0]["result"], {"sent": False})

    def test_outside_shadowlap_it_is_the_tool_itself(self):
        os.environ.pop("SHADOWLAP_URL", None)
        self.use({"origin": "live", "callNo": 1})  # never asked
        ran = []
        self.assertEqual(len(asyncio.run(collect(progress_tool(ran)("x", pages=2)))), 2)
        self.assertEqual(shadowlap._post.sent, [])


class Generators(Stubbed):
    def test_a_generator_tool_streams_and_records_its_last_value(self):
        sidecar = self.use({"origin": "live", "callNo": 2})

        @tool(effect="read")
        def pages(n: int):
            for i in range(n):  # noqa: UP028 -- a generator tool as a user writes one, which a send() reaches
                yield i
            return "done"

        self.assertTrue(inspect.isgeneratorfunction(pages))
        self.assertEqual(list(pages(3)), [0, 1, 2])
        self.assertEqual(sidecar.completes()[0]["result"], 2)

    def test_its_replay_yields_the_recorded_value(self):
        self.use({"origin": "replayed", "callNo": 2, "outcome": "ok", "result": 2})
        ran = []

        @tool(effect="read")
        def pages(n: int):
            ran.append(n)
            yield from range(n)

        self.assertEqual(list(pages(3)), [2])
        self.assertEqual(ran, [])


class Search:
    """A tool written as a class, as frameworks build them: the call is the tool."""

    def __init__(self, ran):
        self.ran = ran

    async def __call__(self, query: str) -> dict:
        self.ran.append(query)
        await asyncio.sleep(0)
        return {"hits": [query]}


class Streamer:
    async def __call__(self, topic: str):
        yield topic


class CallableObjects(Stubbed):
    def test_an_async_call_stays_awaitable_and_is_recorded(self):
        sidecar = self.use({"origin": "live", "callNo": 3})
        ran = []
        search = tool(effect="read")(Search(ran))
        self.assertTrue(inspect.iscoroutinefunction(search))
        self.assertEqual(asyncio.run(search("refunds")), {"hits": ["refunds"]})
        self.assertEqual(sidecar.sent[0][1]["name"], "Search")
        self.assertEqual(sidecar.sent[0][1]["args"], {"query": "refunds"})
        self.assertEqual(sidecar.completes()[0]["result"], {"hits": ["refunds"]})

    def test_its_replay_awaits_the_recorded_result(self):
        self.use({"origin": "replayed", "callNo": 3, "outcome": "ok", "result": {"hits": ["old"]}})
        ran = []
        search = tool(name="search", effect="read")(Search(ran))
        self.assertEqual(asyncio.run(search("refunds")), {"hits": ["old"]})
        self.assertEqual(ran, [])

    def test_a_streaming_call_stays_a_stream(self):
        self.use({"origin": "live", "callNo": 3})
        stream = tool(effect="read")(Streamer())
        self.assertTrue(inspect.isasyncgenfunction(stream))
        self.assertEqual(asyncio.run(collect(stream("orders"))), ["orders"])

    def test_the_implementation_hash_is_the_class_call_not_an_empty_one(self):
        sidecar = self.use({"origin": "live", "callNo": 3})
        asyncio.run(tool(effect="read")(Search([]))("q"))
        empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        self.assertNotEqual(sidecar.sent[0][1]["implHash"], empty)


@unittest.skipUnless(trio, "trio is not installed")
class UnderTrio(Stubbed):
    def test_a_coroutine_tool_records_and_replays(self):
        sidecar = self.use({"origin": "live", "callNo": 1})
        ran = []

        @tool(effect="read")
        async def search(query: str) -> dict:
            ran.append(query)
            await trio.sleep(0)
            return {"hits": [query]}

        self.assertEqual(trio.run(search, "refunds"), {"hits": ["refunds"]})
        self.assertEqual([p for p, _ in sidecar.sent], ["/v1/calls/resolve", "/v1/calls/1/complete"])
        self.use({"origin": "replayed", "callNo": 1, "outcome": "ok", "result": {"hits": ["old"]}})
        self.assertEqual(trio.run(search, "refunds"), {"hits": ["old"]})
        self.assertEqual(ran, ["refunds"])

    def test_the_scope_reaches_the_sidecar_from_the_worker_thread(self):
        seen = []

        def post(cfg, path, body):
            seen.append(shadowlap.current_scope())
            return {"origin": "live", "callNo": 1} if path.endswith("/resolve") else {}

        shadowlap._post = post

        @tool(effect="pure")
        async def add(a: int, b: int) -> int:
            return a + b

        async def main():
            with shadowlap.scope("researcher-1"):
                return await add(1, 2)

        self.assertEqual(trio.run(main), 3)
        self.assertEqual(seen, ["researcher-1", "researcher-1"])

    def test_a_cancel_scope_cutting_the_call_off_is_recorded_as_cancelled(self):
        sidecar = self.use({"origin": "live", "callNo": 5})

        @tool(effect="read")
        async def slow(query: str) -> dict:
            await trio.sleep(5)
            return {"hits": [query]}

        async def main():
            with trio.move_on_after(0.05) as deadline:
                await slow("refunds")
            return deadline.cancelled_caught

        self.assertTrue(trio.run(main))
        [done] = sidecar.completes()
        self.assertEqual(done["outcome"], "error")
        self.assertEqual(done["error"]["name"], "Cancelled")
        self.assertEqual(done["error"]["data"], {"cancelled": True})

    def test_a_replayed_cancellation_waits_for_the_deadline_again(self):
        self.use({"origin": "replayed", "callNo": 5, "outcome": "error", "error": {"name": "Cancelled", "message": "", "data": {"cancelled": True}}})
        ran = []

        @tool(effect="read")
        async def slow(query: str) -> dict:
            ran.append(query)
            return {}

        async def main():
            with trio.move_on_after(0.05) as deadline:
                await slow("refunds")
            return deadline.cancelled_caught

        self.assertTrue(trio.run(main))
        self.assertEqual(ran, [])

    def test_an_async_generator_streams(self):
        sidecar = self.use({"origin": "live", "callNo": 6})

        @tool(effect="read")
        async def pages(n: int):
            for i in range(n):
                await trio.sleep(0)
                yield i

        self.assertEqual(trio.run(collect, pages(2)), [0, 1])
        self.assertEqual(sidecar.completes()[0]["result"], 1)

    def test_user_input_async_asks_off_the_loop(self):
        sidecar = self.use({"origin": "live", "callNo": 7})

        async def read(prompt):
            await trio.sleep(0)
            return "A-1042"

        self.assertEqual(trio.run(shadowlap.user_input_async, "Order? ", read), "A-1042")
        self.assertEqual(sidecar.completes()[0]["result"], {"text": "A-1042"})


@unittest.skipUnless(anyio and trio, "anyio or trio is not installed")
class UnderAnyio(Stubbed):
    def run_on(self, backend):
        sidecar = self.use({"origin": "live", "callNo": 1})

        @tool(effect="read")
        async def search(query: str) -> dict:
            await anyio.sleep(0)
            return {"hits": [query]}

        self.assertEqual(anyio.run(search, "refunds", backend=backend), {"hits": ["refunds"]})
        return sidecar

    def test_on_asyncio(self):
        self.assertEqual(len(self.run_on("asyncio").completes()), 1)

    def test_on_trio(self):
        self.assertEqual(len(self.run_on("trio").completes()), 1)

    def test_a_deadline_on_trio_is_recorded_as_cancelled(self):
        sidecar = self.use({"origin": "live", "callNo": 2})

        @tool(effect="read")
        async def slow() -> dict:
            await anyio.sleep(5)
            return {}

        async def main():
            with anyio.move_on_after(0.05):
                await slow()

        anyio.run(main, backend="trio")
        self.assertEqual(sidecar.completes()[0]["error"]["data"], {"cancelled": True})


class Header(unittest.TestCase):
    def test_every_call_names_the_sdk_and_its_version(self):
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["content-length"]))
                seen.append((self.path, self.headers.get("x-shadowlap-sdk")))
                body = json.dumps({"origin": "live", "callNo": 1} if self.path.endswith("/resolve") else {"ok": True}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        os.environ["SHADOWLAP_URL"] = "http://127.0.0.1:%d/token" % server.server_address[1]
        try:

            @tool(effect="pure")
            def add(a: int, b: int) -> int:
                return a + b

            self.assertEqual(add(1, 2), 3)
        finally:
            os.environ.pop("SHADOWLAP_URL", None)
            server.shutdown()
        self.assertEqual(seen, [("/token/v1/calls/resolve", "python/" + shadowlap.__version__), ("/token/v1/calls/1/complete", "python/" + shadowlap.__version__)])


if __name__ == "__main__":
    unittest.main()
