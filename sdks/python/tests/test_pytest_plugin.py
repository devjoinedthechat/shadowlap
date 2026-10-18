"""The pytest plugin through real pytest, in a subprocess: installing shadowlap loads the plugin into
every pytest run, so it must load on every pytest it supports (6.2 onward, with the pluggy each
brings) and leave unmarked tests alone. A marked test records and replays when the shadowlap CLI of
this repository is built. Skipped where pytest isn't installed."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SDK = os.path.dirname(HERE)
CLI = os.path.join(SDK, "..", "..", "packages", "cli", "bin", "shadowlap.js")
BUILT = os.path.exists(os.path.join(SDK, "..", "..", "packages", "cli", "dist", "index.js")) and shutil.which("node")

try:
    import pytest  # noqa: F401

    HAS_PYTEST = True
except ImportError:
    HAS_PYTEST = False


class _Model(BaseHTTPRequestHandler):
    """An OpenAI-shaped chat endpoint that echoes the prompt and counts its requests."""

    hits = 0

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        type(self).hits += 1
        text = "echo: " + body["messages"][-1]["content"]
        reply = {"id": "c%d" % self.hits, "object": "chat.completion", "created": 1, "model": body.get("model", "m"), "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}}
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


TESTS = '''
import json, os, urllib.request
import pytest

def ask(prompt):
    body = {"model": "gpt-5", "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(os.environ["OPENAI_BASE_URL"].rstrip("/") + "/chat/completions", data=json.dumps(body).encode(), headers={"content-type": "application/json", "authorization": "Bearer test"})
    return json.load(urllib.request.urlopen(req))["choices"][0]["message"]["content"]

def test_plain():
    assert 1 + 1 == 2

@pytest.mark.shadowlap
def test_marked(shadowlap_recording):
    prompt = os.environ.get("PROMPT", "hello")
    assert ask(prompt) == "echo: " + prompt
    assert shadowlap_recording.answer() == "echo: " + prompt
'''


@unittest.skipUnless(HAS_PYTEST, "pytest is not installed")
class PytestPlugin(unittest.TestCase):
    def setUp(self):
        self.project = tempfile.mkdtemp(prefix="sl-pytest-plugin-")
        with open(os.path.join(self.project, "test_agent.py"), "w") as f:
            f.write(textwrap.dedent(TESTS))

    def tearDown(self):
        shutil.rmtree(self.project, ignore_errors=True)

    def pytest(self, *args, env=None):
        full = {k: v for k, v in os.environ.items() if k not in ("CI", "SHADOWLAP_URL", "SHADOWLAP_RUN_ID", "SHADOWLAP_RECORD", "PYTEST_ADDOPTS")}
        full["PYTHONPATH"] = SDK + os.pathsep + full.get("PYTHONPATH", "")
        full.update(env or {})
        # -p loads the plugin whether or not shadowlap is installed with its entry point; with it
        # installed, pytest loads it once.
        installed = subprocess.run([sys.executable, "-c", "from importlib.metadata import entry_points as e; eps = e(); print(any(x.value == 'shadowlap.pytest_plugin' for x in (eps.select(group='pytest11') if hasattr(eps, 'select') else eps.get('pytest11', []))))"], capture_output=True, text=True, env=full).stdout.strip() == "True"
        plugin = [] if installed else ["-p", "shadowlap.pytest_plugin"]
        return subprocess.run([sys.executable, "-m", "pytest", *plugin, "-p", "no:cacheprovider", "-q", *args], cwd=self.project, capture_output=True, text=True, env=full, timeout=180)

    def test_an_unmarked_test_runs_with_the_plugin_loaded(self):
        r = self.pytest("-k", "plain")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("1 passed", r.stdout)

    @unittest.skipUnless(BUILT, "the shadowlap CLI of this repository is not built")
    def test_a_marked_test_records_then_replays(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            env = {"SHADOWLAP_CLI": CLI, "SHADOWLAP_UPSTREAM_OPENAI": "http://127.0.0.1:%d" % server.server_address[1], "SHADOWLAP_TELEMETRY": "0"}
            first = self.pytest(env=env)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertIn("2 passed", first.stdout)
            self.assertEqual(_Model.hits, 1)
            self.assertTrue(os.path.exists(os.path.join(self.project, "__recordings__", "test_agent", "test_marked", "run.json")))
            again = self.pytest(env=dict(env, SHADOWLAP_RECORD="none"))
            self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
            self.assertEqual(_Model.hits, 1)  # replayed offline
            changed = self.pytest(env=dict(env, SHADOWLAP_RECORD="none", PROMPT="goodbye"))
            self.assertEqual(changed.returncode, 1, changed.stdout + changed.stderr)
            self.assertIn("1 failed, 1 passed", changed.stdout)
            self.assertIn("diverged from its recording at call 1", changed.stdout)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
