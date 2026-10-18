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


# A recorded test, then tests without the marker: they must see the environment they had and call
# their model and tools directly, whatever ran before them.
MIXED = '''
import json, os, sys, urllib.request
import pytest
import shadowlap

def ask(prompt):
    body = {"model": "gpt-5", "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(os.environ["OPENAI_BASE_URL"].rstrip("/") + "/chat/completions", data=json.dumps(body).encode(), headers={"content-type": "application/json", "authorization": "Bearer test"})
    return json.load(urllib.request.urlopen(req))["choices"][0]["message"]["content"]

@shadowlap.tool(effect="read")
def lookup(key):
    return {"key": key}

def captured(url):
    capture = sys.modules.get("_shadowlap_capture")
    return capture is not None and capture._rewrite(url) is not None

@pytest.mark.shadowlap
def test_a_marked():
    assert shadowlap.is_active()
    assert os.environ["OPENAI_BASE_URL"] != os.environ["MODEL_URL"]
    assert captured("https://api.openai.com/v1/chat/completions")
    assert lookup("A-1") == {"key": "A-1"}
    assert ask("recorded") == "echo: recorded"

def test_b_unmarked():
    assert not shadowlap.is_active()
    assert os.environ["OPENAI_BASE_URL"] == os.environ["MODEL_URL"]
    assert "SHADOWLAP_CAPTURE" not in os.environ
    assert not captured("https://api.openai.com/v1/chat/completions")
    assert lookup("B-2") == {"key": "B-2"}
    assert ask("direct") == "echo: direct"

@pytest.mark.shadowlap
def test_c_marked_again():
    assert shadowlap.is_active()
    assert ask("recorded again") == "echo: recorded again"

def test_d_unmarked_again():
    assert not shadowlap.is_active()
    assert ask("direct again") == "echo: direct again"
'''


# Tests whose names alone would share a recording: the same name in two classes, two parametrized
# cases that agree for their first 130 characters, and two that differ only in punctuation.
NAMES = '''
import pytest
import shadowlap

@shadowlap.tool(effect="read")
def lookup(key):
    return {"key": key}

class TestRefundAgent:
    @pytest.mark.shadowlap
    def test_happy_path(self):
        assert lookup("A-1") == {"key": "A-1"}

class TestTriageAgent:
    @pytest.mark.shadowlap
    def test_happy_path(self):
        assert lookup("B-2") == {"key": "B-2"}

LONG = "x" * 130

@pytest.mark.shadowlap
@pytest.mark.parametrize("prompt", [LONG + " refund", LONG + " triage"])
def test_prompt(prompt):
    assert lookup(prompt) == {"key": prompt}

@pytest.mark.shadowlap
@pytest.mark.parametrize("prompt", ["balance?", "balance!"])
def test_short(prompt):
    assert lookup(prompt) == {"key": prompt}
'''


@unittest.skipUnless(HAS_PYTEST, "pytest is not installed")
class PytestPlugin(unittest.TestCase):
    def setUp(self):
        _Model.hits = 0
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

    @unittest.skipUnless(BUILT, "the shadowlap CLI of this repository is not built")
    def test_tests_without_the_marker_call_their_model_directly_after_a_recorded_one(self):
        with open(os.path.join(self.project, "test_mixed.py"), "w") as f:
            f.write(textwrap.dedent(MIXED))
        server = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            model = "http://127.0.0.1:%d" % server.server_address[1]
            env = {"SHADOWLAP_CLI": CLI, "SHADOWLAP_UPSTREAM_OPENAI": model, "OPENAI_BASE_URL": model + "/v1", "MODEL_URL": model + "/v1", "SHADOWLAP_TELEMETRY": "0"}
            r = self.pytest("test_mixed.py", env=env)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("4 passed", r.stdout)
            self.assertEqual(_Model.hits, 4)  # two recorded through Shadowlap, two direct
            # Replayed: the recorded tests call nothing, the others still call the model themselves.
            again = self.pytest("test_mixed.py", env=dict(env, SHADOWLAP_RECORD="none"))
            self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
            self.assertEqual(_Model.hits, 6)
        finally:
            server.shutdown()
            server.server_close()

    @unittest.skipUnless(BUILT, "the shadowlap CLI of this repository is not built")
    def test_every_test_gets_a_recording_of_its_own(self):
        with open(os.path.join(self.project, "test_names.py"), "w") as f:
            f.write(textwrap.dedent(NAMES))
        env = {"SHADOWLAP_CLI": CLI, "SHADOWLAP_TELEMETRY": "0"}
        first = self.pytest("test_names.py", env=env)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertIn("6 passed", first.stdout)
        folder = os.path.join(self.project, "__recordings__", "test_names")
        recorded = sorted(os.path.relpath(root, folder) for root, _, files in os.walk(folder) if "run.json" in files)
        self.assertEqual(len(recorded), 6, recorded)
        # A class is a folder; a name that needs nothing else keeps the name alone.
        self.assertIn(os.path.join("TestRefundAgent", "test_happy_path"), recorded)
        self.assertIn(os.path.join("TestTriageAgent", "test_happy_path"), recorded)
        self.assertIn("test_short-balance", recorded)
        # The second of two that would share it ends in a hash of its identity, as docs/testing.md shows.
        self.assertIn("test_short-balance-e33869db", recorded)
        self.assertTrue(all(len(os.path.basename(r)) <= 129 for r in recorded), recorded)
        again = self.pytest("test_names.py", env=dict(env, SHADOWLAP_RECORD="none"))
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("6 passed", again.stdout)
        # A recording made before classes were part of the path still loads for the test that made it.
        os.rename(os.path.join(folder, "TestRefundAgent", "test_happy_path"), os.path.join(folder, "test_happy_path"))
        legacy = self.pytest("test_names.py", "-k", "happy_path", env=dict(env, SHADOWLAP_RECORD="none"))
        self.assertEqual(legacy.returncode, 0, legacy.stdout + legacy.stderr)
        self.assertIn("2 passed", legacy.stdout)


if __name__ == "__main__":
    unittest.main()
