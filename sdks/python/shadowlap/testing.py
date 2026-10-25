"""Recordings for test suites: a test records its agent's model and tool calls the first time it runs,
and replays them offline after that.

The pytest plugin (``@pytest.mark.shadowlap``) is built on this module; any other runner can use
:func:`recording` directly::

    from shadowlap.testing import recording

    def test_triage(self):
        with recording("tests/__recordings__/triage") as rec:
            result = run_agent("triage the inbox")
            self.assertEqual(rec.called("send_email"), 0)
        self.assertEqual(len(result.tickets), 3)

On first use, a ``shadowlap serve --recordings`` process starts for this Python process (the
``shadowlap`` CLI from npm, or ``SHADOWLAP_CLI``). While a recording runs, model calls reach it
through in-process capture, so clients created before it started, at import time, are recorded
too, and the base-URL variables point at it for clients created inside. Outside a recording the
environment is what it was and capture is off: code that runs between recorded tests, such as a
test without the marker, calls its model and tools directly.

``SHADOWLAP_RECORD`` picks the mode: ``missing`` (the default) replays a test that has a recording
and records one that doesn't; ``all`` records every test again; ``none`` only replays, and is the
default when ``CI`` is set, so a missing recording fails in CI instead of calling a model there.
"""

import atexit
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import warnings
from types import TracebackType
from typing import Any, Literal, Optional, cast

__all__ = ["ShadowlapReplayDiverged", "Recording", "recording", "record_mode", "under_shadowlap_run"]

MODES = ("missing", "all", "none")


class ShadowlapReplayDiverged(AssertionError):
    """A test's replay sent a request its recording doesn't have."""

    def __init__(self, message: str, report: str = "", run_id: Optional[str] = None):
        super().__init__(message + ("\n\n" + report if report else ""))
        self.summary = message
        self.report = report
        self.run_id = run_id


class ShadowlapTestError(RuntimeError):
    """Shadowlap could not start or serve a recording."""


def record_mode(explicit: Optional[str] = None) -> str:
    mode = explicit or os.environ.get("SHADOWLAP_RECORD") or ("none" if os.environ.get("CI") else "missing")
    if mode not in MODES:
        raise ShadowlapTestError("SHADOWLAP_RECORD must be missing, all or none, not %r" % mode)
    return mode


class _Host:
    def __init__(self, root: str):
        self.root = os.path.abspath(root)
        self.slot = re.sub(r"[^\w.-]", "-", os.environ.get("PYTEST_XDIST_WORKER") or "main")[:64]
        command = _cli_command() + ["serve", "--recordings"]
        try:
            self.process = subprocess.Popen(command, cwd=self.root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=os.environ.copy())
        except OSError as err:
            raise ShadowlapTestError("could not start %s: %s" % (" ".join(command), err)) from None
        line = _read_line(self.process, timeout=60)
        if not line:
            code = self.process.poll()
            raise ShadowlapTestError("%s exited before it was ready (exit code %s)" % (" ".join(command), code))
        info = json.loads(line)
        self.url = info["url"]
        # This process's slot: the base URLs, SHADOWLAP_URL for the SDK, and capture's configuration.
        # They hold only while a recording runs (enter() to leave()), so code outside one is left alone.
        self.env = {key: value.replace("__SLOT__", self.slot) for key, value in info["env"].items()}
        self._saved: dict[str, Optional[str]] = {}
        self._depth = 0
        if info["capture"]["python"] not in sys.path:
            sys.path.insert(0, info["capture"]["python"])
        # Capture reads its configuration when it is imported, so it is imported under the slot's.
        self.enter()
        try:
            import _shadowlap_capture  # noqa: F401 -- loaded for what it patches: httpx, httpx2, requests, urllib3 and botocore
        finally:
            self.leave()

        atexit.register(self.close)

    def _capture(self, on: bool) -> None:
        capture = sys.modules.get("_shadowlap_capture")
        if capture is not None:
            setattr(capture, "active", on)

    def enter(self) -> None:
        """Points this process at the slot: base URLs, the SDK and in-process capture."""
        self._depth += 1
        if self._depth > 1:
            return
        self._saved = {key: os.environ.get(key) for key in self.env}
        os.environ.update(self.env)
        self._capture(True)

    def leave(self) -> None:
        """Puts the environment back as it was before enter(), and turns capture off. A variable the
        code changed meanwhile keeps its new value."""
        if self._depth == 0:
            return
        self._depth -= 1
        if self._depth > 0:
            return
        self._capture(False)
        for key, value in self._saved.items():
            if os.environ.get(key) != self.env[key]:
                continue
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._saved = {}

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
        try:
            # Never through a proxy: the host is on this machine's loopback.
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=120) as res:
                return cast(dict[str, Any], json.loads(res.read().decode("utf-8")))
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            try:
                message = json.loads(text).get("error", {}).get("message", text)
            except Exception:
                message = text
            raise ShadowlapTestError(message) from None

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                if self.process.stdin is not None:
                    self.process.stdin.close()
                self.process.wait(timeout=10)
            except Exception:
                self.process.kill()


def _cli_command() -> list[str]:
    cli = os.environ.get("SHADOWLAP_CLI")
    if cli:
        if cli.endswith((".js", ".mjs", ".cjs")):
            node = shutil.which("node")
            if not node:
                raise ShadowlapTestError("SHADOWLAP_CLI is a JavaScript file, but there is no node on PATH")
            return [node, cli]
        return [cli]
    exe = shutil.which("shadowlap")
    if exe:
        return [exe]
    npx = shutil.which("npx")
    if npx:
        return [npx, "--no-install", "shadowlap"]
    raise ShadowlapTestError("the shadowlap CLI was not found. Install it (npm install -g shadowlap) or set SHADOWLAP_CLI")


def _read_line(process: "subprocess.Popen[bytes]", timeout: float) -> str:
    out: list[bytes] = []
    stdout = process.stdout
    if stdout is None:
        return ""
    reader = threading.Thread(target=lambda: out.append(stdout.readline()), daemon=True)
    reader.start()
    reader.join(timeout)
    if reader.is_alive():
        process.kill()
        raise ShadowlapTestError("shadowlap serve --recordings did not start within %d seconds" % timeout)
    return out[0].decode("utf-8").strip() if out else ""


_host: Optional[_Host] = None
_outer: Optional[bool] = None


def under_shadowlap_run() -> bool:
    """True when the test runner itself runs under ``shadowlap run`` or ``replay``, which then records everything."""
    global _outer
    if _outer is None:
        _outer = _host is None and bool(os.environ.get("SHADOWLAP_URL"))
    return bool(_outer)


def _get_host(root: Optional[str]) -> _Host:
    global _host
    if _host is None:
        _host = _Host(root or os.getcwd())
    return _host


def _running_host() -> _Host:
    """The host a started recording runs on."""
    if _host is None:
        raise ShadowlapTestError("the Shadowlap host has stopped")
    return _host


def close() -> None:
    global _host
    if _host is not None:
        _host.close()
        _host = None


def _args_match(actual: Any, expected: Any) -> bool:
    """Every expected value is present: dicts partially, anything else exactly (as in ``shadowlap test`` checks)."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and _args_match(actual[k], v) for k, v in expected.items())
    if isinstance(expected, (list, tuple)):
        return isinstance(actual, list) and len(actual) == len(expected) and all(_args_match(a, e) for a, e in zip(actual, expected))
    if isinstance(expected, bool) or isinstance(actual, bool):
        return actual is expected  # JSON true is not 1
    return bool(actual == expected)


class Recording:
    """One test's recording: started before the test, finished after it.

    While the test runs, it also tells what the agent did, to assert on as well as what it returned::

        assert rec.called("send_email") == 0
        assert rec.called("issue_refund", order_id="A-1042") == 1
        assert "refund issued" in rec.answer()
    """

    def __init__(self, path: str, name: Optional[str] = None, mode: Optional[str] = None, command: Optional[list[str]] = None, root: Optional[str] = None):
        self.path = path
        self.name = name
        self.mode = record_mode(mode)
        self.command = command
        self.root = root
        self.run_id: Optional[str] = None
        #: ``record`` or ``replay``, once started.
        self.action: Optional[str] = None
        self.result: Optional[dict[str, Any]] = None
        # Whether this recording has pointed the process at its slot (see _Host.enter).
        self._entered = False
        # The placeholder keys a replay set, each with the value its variable had before (see _place).
        self._placed: dict[str, tuple[Optional[str], str]] = {}

    def start(self) -> "Recording":
        if under_shadowlap_run():
            return self
        host = _get_host(self.root)
        body: dict[str, Any] = {"recording": os.path.abspath(self.path), "slot": host.slot, "mode": self.mode, "name": self.name}
        if self.command:
            body["command"] = self.command
        started = host.post("/v1/recordings/start", body)
        self.result = None
        self.run_id = started["runId"]
        self.action = started["mode"]
        if not self._entered:
            host.enter()
            self._entered = True
        self._place(started.get("placeholders") or {})
        return self

    def _place(self, placeholders: dict[str, str]) -> None:
        """Sets the placeholder keys a replay comes with (``shadowlap-offline-replay-placeholder``), each
        only where the variable holds no value, so a model client built the default way, which takes
        its key from the environment, sends what the recording answers. The replay is offline: no
        placeholder goes anywhere."""
        self._unplace()
        for key, value in placeholders.items():
            if (os.environ.get(key) or "").strip():
                continue
            self._placed[key] = (os.environ.get(key), value)
            os.environ[key] = value

    def _unplace(self) -> None:
        """Puts back each variable the test left holding its placeholder."""
        for key, (before, value) in self._placed.items():
            if os.environ.get(key) != value:
                continue
            if before is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = before
        self._placed = {}

    def _read(self) -> dict[str, Any]:
        if self.run_id is None:
            if under_shadowlap_run():
                raise ShadowlapTestError("this test has no recording of its own to read, because the test runner runs under shadowlap run or replay. Run the tests directly.")
            raise ShadowlapTestError("the recording has not started: read calls while the test runs")
        if self.result is not None:
            raise ShadowlapTestError("the recording has finished: read calls while the test runs")
        return _running_host().post("/v1/recordings/calls", {"runId": self.run_id})

    def calls(self) -> list[dict[str, Any]]:
        """Every call so far, in order: model calls, tool calls, clock and random reads. Each is a dict with
        ``call_no``, ``kind``, ``name``, ``origin`` (``live``, ``replayed``, ``blocked``, ``stubbed``) and
        ``outcome``; tool calls add ``args`` and ``result`` or ``error``, model calls ``model``, and calls
        made in a scope ``scope``."""
        return [_call(c) for c in self._read()["calls"]]

    def tool_calls(self, name: Optional[str] = None) -> list[dict[str, Any]]:
        """Tool calls so far, or those of one tool. Calls blocked after a fork are included."""
        return [c for c in self.calls() if c["kind"] == "tool" and (name is None or c["name"] == name)]

    def called(self, name: str, /, **args: Any) -> int:
        """How many times a tool was called, counting only calls whose arguments contain ``args`` when given."""
        return sum(1 for c in self.tool_calls(name) if not args or _args_match(c.get("args"), args))

    def answer(self) -> Optional[str]:
        """The text of the last model response; None before one."""
        answer = self._read()["answer"]
        return answer if isinstance(answer, str) else None

    def finish(self, passed: bool, error: Optional[BaseException] = None) -> None:
        """Ends the recording. Raises :class:`ShadowlapReplayDiverged` when the replay diverged."""
        if self.run_id is None:
            return
        self._unplace()
        if self._entered:
            self._entered = False
            if _host is not None:
                _host.leave()
        self.result = result = _running_host().post("/v1/recordings/end", {"runId": self.run_id, "passed": passed})
        if not result["ok"]:
            message = str(result["message"])
            if error is not None:
                detail = str(error).splitlines()[0] if str(error) else ""
                if len(detail) > 160:
                    detail = detail[:160] + "…"
                message += "; the test then failed with %s: %s" % (type(error).__name__, detail)
            raise ShadowlapReplayDiverged(message, result.get("report") or "", self.run_id)
        if result.get("message"):
            warnings.warn("shadowlap: %s (%s)" % (result["message"], result["recording"]), stacklevel=2)

    def __enter__(self) -> "Recording":
        return self.start()

    def __exit__(self, exc_type: Optional[type[BaseException]], exc: Optional[BaseException], tb: Optional[TracebackType]) -> Literal[False]:
        if exc_type is None:
            self.finish(True)
        else:
            try:
                self.finish(False, exc)
            except ShadowlapReplayDiverged as diverged:
                raise diverged from exc
        return False


def _call(c: dict[str, Any]) -> dict[str, Any]:
    out = {"call_no": c["callNo"], "kind": c["kind"], "name": c["name"], "origin": c["origin"], "outcome": c["outcome"]}
    for key in ("scope", "model", "args", "result", "error"):
        if key in c:
            out[key] = c[key]
    return out


def recording(path: str, name: Optional[str] = None, mode: Optional[str] = None) -> Recording:
    """A context manager that replays ``path`` when it holds a recording, and records it otherwise."""
    return Recording(path, name=name, mode=mode)
