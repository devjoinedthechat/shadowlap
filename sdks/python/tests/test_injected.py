"""Tool failures `shadowlap replay --fail-at <call>=timeout|error|<status>` asks for: the tool never
runs, nothing is completed, and the agent sees the kind of failure it handles. The sidecar is
stubbed; the vitest suite runs this file."""

import asyncio
import copy
import json
import os
import pickle
import socket
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import shadowlap  # noqa: E402
from shadowlap import ReplayedError, ShadowlapInjectedFailure, ShadowlapInjectedHTTPError, ShadowlapInjectedTimeout, tool  # noqa: E402


class Sidecar:
    """Answers resolve with a fixed decision and keeps what the SDK sent."""

    def __init__(self, decision):
        self.decision = decision
        self.sent = []

    def __call__(self, cfg, path, body):
        json.dumps(body)
        self.sent.append((path, body))
        return dict(self.decision) if path.endswith("/resolve") else {}


def injected(kind, error, **extra):
    return {"origin": "replayed", "callNo": 3, "outcome": "error", "error": error, "injected": {"kind": kind, **extra}}


class InjectedFailures(unittest.TestCase):
    def setUp(self):
        self._post = shadowlap._post
        os.environ["SHADOWLAP_URL"] = "http://sidecar.test"
        self.ran = []

    def tearDown(self):
        shadowlap._post = self._post
        os.environ.pop("SHADOWLAP_URL", None)

    def search(self):
        @tool(effect="read")
        def search_web(query: str) -> dict:
            self.ran.append(query)
            return {"results": []}

        return search_web

    def test_a_timeout_is_a_timeout_error_and_the_tool_never_runs(self):
        sidecar = Sidecar(injected("timeout", {"name": "TimeoutError", "message": "search_web timed out", "code": "ETIMEDOUT"}))
        shadowlap._post = sidecar
        search_web = self.search()
        with self.assertRaises(TimeoutError) as caught:
            search_web("refunds")
        err = caught.exception
        self.assertIsInstance(err, ShadowlapInjectedTimeout)
        # Classes of their own before Python 3.11: an agent catching either still catches it.
        self.assertIsInstance(err, asyncio.TimeoutError)
        self.assertIsInstance(err, socket.timeout)
        self.assertEqual(str(err), "search_web timed out")
        self.assertEqual((err.tool, err.tool_args, err.kind, err.injected), ("search_web", {"query": "refunds"}, "timeout", True))
        self.assertEqual(self.ran, [])
        # Shadowlap answered it: there is nothing to complete.
        self.assertEqual([path for path, _ in sidecar.sent], ["/v1/calls/resolve"])

    def test_an_http_failure_carries_its_status_like_an_http_client_error(self):
        shadowlap._post = Sidecar(injected("status", {"name": "HTTPError", "message": "HTTP 429 Too Many Requests"}, status=429))
        with self.assertRaises(ShadowlapInjectedHTTPError) as caught:
            self.search()("refunds")
        err = caught.exception
        self.assertEqual((err.status_code, err.status, err.response.status_code), (429, 429, 429))
        self.assertEqual(err.response.reason_phrase, "Too Many Requests")
        self.assertNotIsInstance(err, TimeoutError)
        self.assertEqual(self.ran, [])

    def test_an_error_carries_exactly_the_message_given(self):
        shadowlap._post = Sidecar(injected("error", {"name": "Error", "message": "connection reset by peer"}, message="connection reset by peer"))
        with self.assertRaises(ShadowlapInjectedFailure) as caught:
            self.search()("refunds")
        self.assertEqual(str(caught.exception), "connection reset by peer")
        self.assertNotIsInstance(caught.exception, ReplayedError)

    def test_async_tools_fail_the_same_way(self):
        shadowlap._post = Sidecar(injected("timeout", {"name": "TimeoutError", "message": "fetch timed out"}))
        ran = []

        @tool(effect="read")
        async def fetch(url: str) -> str:
            ran.append(url)
            return "page"

        async def main():
            try:
                await fetch("https://example.com")
            except TimeoutError as err:
                return str(err)

        self.assertEqual(asyncio.run(main()), "fetch timed out")
        self.assertEqual(ran, [])

    def test_an_agent_that_catches_asyncio_timeout_around_wait_for_catches_it(self):
        shadowlap._post = Sidecar(injected("timeout", {"name": "TimeoutError", "message": "fetch timed out"}))

        @tool(effect="read")
        async def fetch(url: str) -> str:
            return "page"

        async def main():
            try:
                return await asyncio.wait_for(fetch("https://example.com"), timeout=5)
            except asyncio.TimeoutError:
                return "gave up"

        self.assertEqual(asyncio.run(main()), "gave up")

    def test_the_errors_survive_copy_and_pickle(self):
        err = shadowlap._injected("t", {"a": 1}, {"kind": "status", "status": 503}, {"name": "HTTPError", "message": "HTTP 503 Service Unavailable"})
        for again in (copy.copy(err), pickle.loads(pickle.dumps(err))):
            self.assertIsInstance(again, ShadowlapInjectedHTTPError)
            self.assertEqual((str(again), again.status_code, again.tool_args), ("HTTP 503 Service Unavailable", 503, {"a": 1}))
        timeout = shadowlap._injected("t", {}, {"kind": "timeout"}, {"name": "TimeoutError", "message": "t timed out", "code": "ETIMEDOUT"})
        for again in (copy.copy(timeout), pickle.loads(pickle.dumps(timeout))):
            self.assertIsInstance(again, ShadowlapInjectedTimeout)
            self.assertIsInstance(again, asyncio.TimeoutError)
            self.assertEqual((str(again), again.code), ("t timed out", "ETIMEDOUT"))

    def test_an_origin_this_sdk_does_not_know_is_an_error_not_a_reason_to_run_the_tool(self):
        shadowlap._post = Sidecar({"origin": "teleported", "callNo": 1})
        with self.assertRaises(RuntimeError) as caught:
            self.search()("refunds")
        self.assertIn("unknown origin", str(caught.exception))
        self.assertEqual(self.ran, [])

    def test_a_recorded_error_is_still_a_replayed_error(self):
        shadowlap._post = Sidecar({"origin": "replayed", "callNo": 1, "outcome": "error", "error": {"name": "ValueError", "message": "bad query"}})
        with self.assertRaises(ReplayedError):
            self.search()("refunds")


if __name__ == "__main__":
    unittest.main()
