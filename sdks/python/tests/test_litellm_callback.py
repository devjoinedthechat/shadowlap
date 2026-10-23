"""The LiteLLM callback's capture, without LiteLLM installed: its base class is stood in for. A call
that names no start time (no arrival time on the inbound request, none from LiteLLM) is stamped now."""

import json
import os
import sys
import tempfile
import time
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def load_callback():
    """shadowlap.litellm_callback, over a stand-in for the one LiteLLM module it imports."""
    if "litellm.integrations.custom_logger" not in sys.modules:
        custom_logger = types.ModuleType("litellm.integrations.custom_logger")
        custom_logger.CustomLogger = type("CustomLogger", (), {})
        sys.modules.setdefault("litellm", types.ModuleType("litellm"))
        sys.modules.setdefault("litellm.integrations", types.ModuleType("litellm.integrations"))
        sys.modules["litellm.integrations.custom_logger"] = custom_logger
    from shadowlap import litellm_callback

    return litellm_callback


class Capture(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.environ["SHADOWLAP_CAPTURE_DIR"] = self.dir

    def tearDown(self):
        os.environ.pop("SHADOWLAP_CAPTURE_DIR", None)

    def lines(self):
        [name] = os.listdir(self.dir)
        with open(os.path.join(self.dir, name), encoding="utf-8") as f:
            return [json.loads(line) for line in f]

    def test_a_call_with_no_start_time_is_stamped_now(self):
        callback = load_callback()
        request = {"url": "http://proxy/v1/chat/completions", "method": "POST", "headers": {"x-shadowlap-run": "run-1"}, "body": {"model": "gpt", "messages": []}}
        before = int(time.time() * 1000)
        callback.ShadowlapCapture()._record({"litellm_params": {"proxy_server_request": request}}, {"id": "x"}, None, None, failed=False)
        [line] = self.lines()
        self.assertGreaterEqual(line["startedAt"], before)
        self.assertEqual(line["runKey"], "run-1")
        self.assertNotIn("timeMs", line)


if __name__ == "__main__":
    unittest.main()
