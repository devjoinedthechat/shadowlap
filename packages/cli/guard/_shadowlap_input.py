"""Shadowlap's recorded user input for Python agents, loaded by the sitecustomize next to it.

What a person types is input from outside, like a tool's result: each ``input()`` and each read of
``sys.stdin`` (``readline``, ``read``, ``readlines``, iterating over it) is recorded as a
``user_input`` tool call with effect read, ``input: true``, and the prompt as its argument; the
answer is its result, ``{"text": ...}``. A replay serves the answers from the recording, so
``shadowlap test``, ``blame`` and ``verify``, which start agents with no one at the keyboard, run
interactive agents too. When the input ended (Ctrl-D, an empty pipe), that is recorded as well, and
replays as ``EOFError`` from ``input()`` and an empty string from a read.

Only the input Shadowlap gave the agent counts: a terminal, the null device (stdin ignored), or the
very pipe or file ``shadowlap`` itself was given (``SHADOWLAP_STDIN`` names it). A child process that
talks to its parent over a pipe, an MCP server for one, is left alone; so is ``sys.stdin.buffer``.

``shadowlap.user_input()`` in the SDK records other human input the same way (a chat window, a
message from Slack) and goes through this module when it is loaded, so nothing is recorded twice.
"""

from __future__ import annotations

import builtins
import contextlib
import contextvars
import json
import os
import stat
import sys
import time
import urllib.error
import urllib.request

# Typing's names for mypy alone (mypy.ini beside this file): at run time the module imports nothing it needn't.
TYPE_CHECKING = False
if TYPE_CHECKING:
    from collections.abc import Iterator
    from typing import Any, Callable, Optional, TextIO

_url = os.environ.get("SHADOWLAP_URL")
_run = os.environ.get("SHADOWLAP_RUN_ID")
# A context variable, not a thread-local: asyncio.to_thread() and run_in_executor carry it into the
# worker thread, so input() read there for shadowlap.user_input_async() isn't recorded a second time.
_depth: contextvars.ContextVar[int] = contextvars.ContextVar("shadowlap_input_passthrough", default=0)

active = False
original_input = builtins.input


def _stdin_origin() -> Optional[str]:
    """'person' when someone may type on fd 0, 'nobody' when it is the null device, else None."""
    try:
        if os.isatty(0):
            return "person"
        own = os.fstat(0)
        # A character device that is not a terminal is the null device (stdin ignored), on Windows too.
        if stat.S_ISCHR(own.st_mode):
            return "nobody"
        # Unsigned 64-bit, as the CLI writes it: a socket's device number is -1 on macOS. On Windows
        # the CLI names a file's volume by its 32-bit serial number, where Python 3.12 and later give
        # all 64 bits of it, and up to 128 bits of the file's id, whose low 64 are the CLI's. (A pipe
        # there has neither, so only a file is ever the input named.)
        mask = (1 << 64) - 1
        dev = own.st_dev & (0xFFFFFFFF if os.name == "nt" else mask)
        if own.st_ino and os.environ.get("SHADOWLAP_STDIN") == "%d:%d" % (dev, own.st_ino & mask):
            return "person"
    except OSError:
        pass
    return None


@contextlib.contextmanager
def passthrough() -> Iterator[None]:
    """Reads inside this block go straight to the real input, unrecorded: the recording is made around them."""
    token = _depth.set(_depth.get() + 1)
    try:
        yield
    finally:
        _depth.reset(token)


def _passing_through() -> bool:
    return _depth.get() > 0


def _scope() -> Optional[str]:
    var = getattr(sys, "_shadowlap_scope_var", None)
    scope = var.get() if var is not None else None
    if scope:
        return str(scope)
    raw = (os.environ.get("SHADOWLAP_SCOPE") or "").strip()
    if raw and len(raw) <= 200 and not any(ord(c) < 32 or ord(c) == 127 for c in raw):
        return raw
    return None


def _scope_header(scope: str) -> str:
    """The scope as x-shadowlap-scope carries it: % and anything outside printable ASCII percent-encoded
    (UTF-8), as the SDK sends it, so a name of any language fits a header."""
    from urllib.parse import quote

    return "".join(c if " " <= c <= "~" and c != "%" else quote(c.encode("utf-8", "replace"), safe="") for c in scope)


def _post(path: str, body: dict[str, Any]) -> Any:
    headers = {"content-type": "application/json", "user-agent": "shadowlap-input-python"}
    if _run:
        headers["x-shadowlap-run"] = _run
    scope = _scope()
    if scope:
        headers["x-shadowlap-scope"] = _scope_header(scope)
    req = urllib.request.Request(str(_url).rstrip("/") + path, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        # Never through a proxy (HTTP_PROXY): the sidecar is on this machine's loopback.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            message = json.loads(text).get("error", {}).get("message", text)
        except Exception:
            message = text
        raise RuntimeError("shadowlap sidecar %s failed (%s): %s" % (path, e.code, message)) from None


def text_of(result: Any) -> str:
    """The text of a recorded answer: ``{"text": ...}``, or a bare string from an override."""
    if isinstance(result, str):
        return result
    if isinstance(result, dict) and isinstance(result.get("text"), str):
        return str(result["text"])
    return "" if result is None else json.dumps(result)


class _ServedEnd(EOFError):
    """The recording says the input ended here."""


def record(prompt: str, read_live: Callable[[], dict[str, Any]]) -> tuple[dict[str, Any], bool]:
    """One person's answer: from the recording when the replay has it, else ``read_live()`` and recorded.

    ``read_live`` returns the result to record, ``{"text": ...}``, or raises EOFError when the input
    ended. Returns ``(result, served)``; raises EOFError when the input ended, recorded or live.
    """
    r = _post("/v1/calls/resolve", {"kind": "tool", "name": "user_input", "effect": "read", "args": {"prompt": prompt}, "input": True})
    origin = r.get("origin")
    if origin == "replayed":
        if r.get("outcome") == "ok":
            result = r.get("result")
            return (result if isinstance(result, dict) and isinstance(result.get("text"), str) else {"text": text_of(result)}), True
        error = r.get("error") or {}
        if error.get("name") == "KeyboardInterrupt":
            raise KeyboardInterrupt()
        raise _ServedEnd(error.get("message") or "end of input")
    if origin != "live":
        raise RuntimeError("shadowlap: unexpected origin %r for user input" % origin)
    started = time.time()

    def complete(body: dict[str, Any]) -> None:
        body["latencyMs"] = int((time.time() - started) * 1000)
        _post("/v1/calls/%d/complete" % r["callNo"], body)

    try:
        with passthrough():
            result = read_live()
    except EOFError:
        complete({"outcome": "error", "error": {"name": "EOFError", "message": "end of input"}})
        raise
    except BaseException as err:
        complete({"outcome": "error", "error": {"name": type(err).__name__, "message": str(err)}})
        raise
    complete({"outcome": "ok", "result": result})
    return result, False


def _show(prompt: str, text: Optional[str]) -> None:
    """A served answer as the terminal would have shown it: the prompt, and the line as if typed."""
    out = sys.stdout
    try:
        if prompt:
            out.write(prompt)
        if text is not None and out.isatty():
            out.write(text + "\n")
        out.flush()
    except Exception:
        pass


def recorded_input(prompt: object = "") -> str:
    if _passing_through():
        return original_input(prompt)
    prompt = str(prompt)
    try:
        result, served = record(prompt, lambda: {"text": original_input(prompt)})
    except _ServedEnd:
        # input() shows its prompt before it finds the input ended.
        _show(prompt, None)
        raise EOFError() from None
    if served:
        _show(prompt, result["text"])
    return str(result["text"])


class RecordedStdin:
    """``sys.stdin`` with each read recorded; everything else is the real stream's."""

    def __init__(self, real: TextIO) -> None:
        self._real = real

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    # Looked up on the type, not through __getattr__.
    def __enter__(self) -> RecordedStdin:
        return self

    def __exit__(self, *exc: Any) -> Any:
        return self._real.__exit__(*exc)

    def __repr__(self) -> str:
        return repr(self._real)

    def _line(self) -> str:
        def live() -> dict[str, Any]:
            line = self._real.readline()
            if line == "":
                raise EOFError()
            if line.endswith("\n"):
                return {"text": line[:-1]}
            # The last line had no line ending: remember that, so a replay returns it the same way.
            return {"text": line, "newline": False}

        try:
            result, _ = record("", live)
        except EOFError:
            return ""
        return str(result["text"]) + ("" if result.get("newline") is False else "\n")

    def readline(self, size: Optional[int] = -1) -> str:
        if _passing_through() or (size is not None and size >= 0):
            # None reads as -1 does: up to the line's end.
            return self._real.readline(-1 if size is None else size)
        return self._line()

    def read(self, size: Optional[int] = -1) -> str:
        if _passing_through() or (size is not None and size >= 0):
            # None reads as -1 does: to the end.
            return self._real.read(-1 if size is None else size)

        try:
            result, _ = record("", lambda: {"text": self._real.read()})
        except EOFError:
            return ""
        return str(result["text"])

    def readlines(self, hint: int = -1) -> list[str]:
        if _passing_through():
            return self._real.readlines(hint)
        lines: list[str] = []
        while True:
            line = self.readline()
            if not line:
                return lines
            lines.append(line)

    def __iter__(self) -> RecordedStdin:
        return self

    def __next__(self) -> str:
        line = self.readline()
        if not line:
            raise StopIteration
        return line


def _install() -> None:
    global active
    if not _url or getattr(builtins, "_shadowlap_input", False) or _stdin_origin() is None:
        return
    setattr(builtins, "_shadowlap_input", True)
    builtins.input = recorded_input
    if sys.stdin is not None and not isinstance(sys.stdin, RecordedStdin):
        setattr(sys, "stdin", RecordedStdin(sys.stdin))
    # A password is never recorded: getpass falls back to reading sys.stdin without a terminal.
    import getpass

    unrecorded = getpass.getpass

    def getpass_unrecorded(*args: Any, **kwargs: Any) -> str:
        with passthrough():
            return unrecorded(*args, **kwargs)

    getpass.getpass = getpass_unrecorded
    active = True


_install()
