"""trust="untrusted" on a tool: sent with each call so the recording marks the reads shadowlap
injection plants in, and nothing sent for a tool that doesn't say so. The sidecar is stubbed; the
vitest suite runs this file, and packages/sidecar/test/trust.test.ts drives a real sidecar."""

import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import shadowlap  # noqa: E402
from shadowlap import tool  # noqa: E402


class Sidecar:
    def __init__(self):
        self.sent = []

    def __call__(self, cfg, path, body):
        json.dumps(body, allow_nan=False)
        self.sent.append((path, body))
        return {"origin": "live", "callNo": len(self.sent)} if path.endswith("/resolve") else {}


class Trust(unittest.TestCase):
    def setUp(self):
        self._post = shadowlap._post
        os.environ["SHADOWLAP_URL"] = "http://sidecar.test"

    def tearDown(self):
        shadowlap._post = self._post
        os.environ.pop("SHADOWLAP_URL", None)

    def test_an_untrusted_read_says_so_with_every_call_sync_and_async(self):
        sidecar = Sidecar()
        shadowlap._post = sidecar

        @tool(effect="read", trust="untrusted")
        def fetch_page(url: str) -> dict:
            return {"url": url, "text": "a page"}

        @tool(name="fetch_async", effect="read", trust="untrusted")
        async def fetch_async(url: str) -> dict:
            return {"url": url}

        @tool(effect="read")
        def search(query: str) -> list:
            return [query]

        @tool(effect="read", trust="trusted")
        def lookup(key: str) -> str:
            return key

        fetch_page("https://example.com/a")
        asyncio.run(fetch_async("https://example.com/b"))
        search("x")
        lookup("k")
        resolves = [body for path, body in sidecar.sent if path.endswith("/resolve")]
        self.assertEqual([(b["name"], b.get("trust")) for b in resolves], [("fetch_page", "untrusted"), ("fetch_async", "untrusted"), ("search", None), ("lookup", None)])

    def test_an_unknown_trust_is_refused_when_the_tool_is_defined(self):
        with self.assertRaises(TypeError) as caught:
            tool(effect="read", trust="maybe")
        self.assertIn('trust must be "trusted" or "untrusted"', str(caught.exception))

    def test_the_adapters_pass_it_on(self):
        from shadowlap.adapters.crewai import with_effect as crew_effect

        sidecar = Sidecar()
        shadowlap._post = sidecar

        class CrewTool:
            name = "read_inbox"

            def __init__(self):
                self.func = lambda folder: {"mail": [folder]}

        wrapped = crew_effect(CrewTool(), "read", trust="untrusted")
        wrapped.func(folder="inbox")
        resolves = [body for path, body in sidecar.sent if path.endswith("/resolve")]
        self.assertEqual([(b["name"], b.get("trust")) for b in resolves], [("read_inbox", "untrusted")])

    def test_outside_shadowlap_the_tool_runs_as_it_is(self):
        os.environ.pop("SHADOWLAP_URL", None)

        @tool(effect="read", trust="untrusted")
        def fetch_page(url: str) -> str:
            return "page " + url

        self.assertEqual(fetch_page("u"), "page u")


if __name__ == "__main__":
    unittest.main()
