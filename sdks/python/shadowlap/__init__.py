"""Shadowlap SDK for Python.

A thin client of the sidecar's call resolution API. No hashing or matching
logic lives here. When Shadowlap is not active (no SHADOWLAP_URL), everything is a passthrough.
"""

from __future__ import annotations

import asyncio
import builtins
import contextlib
import contextvars
import functools
import hashlib
import inspect
import json
import math
import os
import random as _random
import re
import sys
import time
import urllib.error
import urllib.request
import uuid as _uuid
from typing import Any, Callable, Iterator, Optional, TypeVar

__all__ = [
    "tool",
    "now",
    "random",
    "uuid",
    "is_active",
    "ShadowlapWriteBlocked",
    "ReplayedError",
    "ShadowlapInjectedFailure",
    "ShadowlapInjectedTimeout",
    "ShadowlapInjectedHTTPError",
    "serialize_error",
    "context_params",
    "scope",
    "current_scope",
    "user_input",
    "user_input_async",
]

__version__ = "0.1.0"

F = TypeVar("F", bound=Callable[..., Any])
_EFFECTS = ("pure", "read", "write")


class ShadowlapWriteBlocked(RuntimeError):
    """Raised when a `write` tool is reached after divergence under the default `--writes block`.
    `tool` is the tool's name and `tool_args` the arguments it was called with."""

    def __init__(self, tool: str, args: dict, message: Optional[str] = None):
        super().__init__(message or f"write tool {tool} blocked after divergence")
        self.tool = tool
        # Not `self.args`: that is the exception's own message tuple, which str() and copy() use.
        self.tool_args = args

    def __reduce__(self):
        # copy, pickle and multiprocessing rebuild an exception from its constructor arguments.
        return (type(self), (self.tool, self.tool_args, str(self)))


class ReplayedError(Exception):
    """A recorded error, replayed. The original class is not preserved; name, message and code are.

    It reads as the recorded error: ``ReplayedError({"name": "ValueError", ...})`` is an instance of a
    subclass named ``ValueError``, so ``str()``, ``repr()``, ``type(e).__name__`` and a traceback's
    last line are what they were when the call was recorded. An agent that hands a tool's error to
    the model hands it the same text on replay, and ``except ReplayedError`` still catches it."""

    def __new__(cls, error: Optional[dict] = None, *args: Any, **kwargs: Any):
        if cls is ReplayedError and isinstance(error, dict):
            cls = _replayed_class(str(error.get("name") or "Error"))
        return super().__new__(cls)

    def __init__(self, error: dict):
        super().__init__(error.get("message", "recorded error"))
        self.name = error.get("name", "Error")
        self.code = error.get("code")
        self.data = error.get("data")

    def __reduce__(self):
        # Rebuilt through ReplayedError, which picks the class for the name again: the class itself is
        # made at run time, and pickle would look it up by its name (ValueError) and find another.
        return (ReplayedError, ({"name": self.name, "message": super().__str__(), "code": self.code, "data": self.data},))


_REPLAYED_CLASSES: dict = {}


def _replayed_class(name: str) -> type:
    """The ReplayedError subclass for a recorded error's name, one per name. A builtin's name (ValueError,
    KeyError) is shown without a module, as the builtin is."""
    cls = _REPLAYED_CLASSES.get(name)
    if cls is None:
        builtin = getattr(builtins, name, None)
        is_builtin = isinstance(builtin, type) and issubclass(builtin, BaseException)
        cls = type(name, (ReplayedError,), {"__module__": "builtins" if is_builtin else __name__, "__qualname__": name, "__doc__": ReplayedError.__doc__})
        _REPLAYED_CLASSES[name] = cls
    return cls


class ShadowlapInjectedFailure(Exception):
    """Raised instead of running a tool that ``shadowlap replay --fail-at <call>=timeout|error|<status>``
    fails: the tool does not run, and the agent's error path does. ``tool`` and ``tool_args`` name the
    call; ``kind`` is ``timeout``, ``error`` or ``status``; ``injected`` is always True, to tell it from
    a real failure. A timeout is also a ``TimeoutError`` and an HTTP failure carries its status, so the
    handling the agent has for the real thing is what runs."""

    injected = True

    def __init__(self, tool: str, args: dict, failure: dict, error: dict):
        super().__init__(error.get("message", "injected failure"))
        self.tool = tool
        self.tool_args = args
        self.failure = failure
        self.kind = failure.get("kind", "error")
        self.name = error.get("name", "Error")
        self.code = error.get("code")

    def __reduce__(self):
        return (type(self), (self.tool, self.tool_args, self.failure, {"name": self.name, "message": str(self), "code": self.code}))


def _timeout_classes() -> tuple:
    """The classes an agent may catch a timeout as. From Python 3.11 ``asyncio.TimeoutError`` and
    ``socket.timeout`` are ``TimeoutError`` itself; before that they are classes of their own, and an
    agent's ``except asyncio.TimeoutError`` around ``asyncio.wait_for`` must catch the injected one too."""
    import socket

    classes = [ShadowlapInjectedFailure, TimeoutError]
    for cls in (asyncio.TimeoutError, socket.timeout):
        if not any(issubclass(c, cls) for c in classes):
            classes.append(cls)
    return tuple(classes)


class ShadowlapInjectedTimeout(*_timeout_classes()):  # type: ignore[misc]
    """A tool timeout ``--fail-at <call>=timeout`` asked for: ``except TimeoutError`` catches it, and
    so do ``except asyncio.TimeoutError`` and ``except socket.timeout`` on every Python the SDK runs on."""


class _InjectedResponse:
    """The little of an HTTP response an error handler reads: ``status_code``, ``status``, ``headers``, ``text``."""

    def __init__(self, status: int, text: str):
        self.status_code = status
        self.status = status
        self.headers: dict = {}
        self.text = text
        self.reason_phrase = text.split(" ", 2)[-1] if text.startswith("HTTP ") else ""

    def json(self) -> dict:
        return {"error": {"message": self.text}}


class ShadowlapInjectedHTTPError(ShadowlapInjectedFailure):
    """An HTTP failure ``--fail-at <call>=<status>`` asked for, shaped like the errors HTTP clients
    raise: ``status_code`` and ``status`` on the error and on its ``response``."""

    def __init__(self, tool: str, args: dict, failure: dict, error: dict):
        super().__init__(tool, args, failure, error)
        self.status_code = int(failure.get("status", 500))
        self.status = self.status_code
        self.response = _InjectedResponse(self.status_code, str(self))


def _injected(tool: str, args: dict, failure: dict, error: dict) -> ShadowlapInjectedFailure:
    kind = failure.get("kind")
    cls = ShadowlapInjectedTimeout if kind == "timeout" else ShadowlapInjectedHTTPError if kind == "status" else ShadowlapInjectedFailure
    return cls(tool, args, failure, error)


def _unknown_origin(tool: str, origin: Any) -> RuntimeError:
    # Never guess: running the tool on an answer this SDK doesn't know could repeat a side effect.
    return RuntimeError(f"shadowlap sidecar answered {tool} with an unknown origin {origin!r}; update the shadowlap package")


def _config() -> Optional[tuple]:
    url = os.environ.get("SHADOWLAP_URL")
    if not url:
        return None
    return url.rstrip("/"), os.environ.get("SHADOWLAP_RUN_ID")


def is_active() -> bool:
    return _config() is not None


# One variable per process, shared with Shadowlap's capture module, which may be imported first.
_SCOPE = getattr(sys, "_shadowlap_scope_var", None)
if _SCOPE is None:
    _SCOPE = contextvars.ContextVar("shadowlap_scope", default=None)
    sys._shadowlap_scope_var = _SCOPE


def _base_scope() -> Optional[str]:
    """The scope a process starts in, from ``SHADOWLAP_SCOPE``.

    A scope is normally entered in code, but an agent whose branches are separate processes — a
    worker pool, a subprocess per sub-agent — has no in-process place to do that, and without a
    scope those branches can be served each other's recorded answers. Setting the variable when
    spawning the child names its branch instead; scopes entered inside it nest underneath. Limits
    match what the sidecar accepts.
    """
    raw = (os.environ.get("SHADOWLAP_SCOPE") or "").strip()
    if not raw or len(raw) > 200 or any(ord(c) < 32 or ord(c) == 127 for c in raw):
        return None
    return raw


@contextlib.contextmanager
def scope(name: str) -> Iterator[str]:
    """Runs a block as a named branch of the agent, such as one sub-agent of several running at once.

    Every call made inside it carries the scope: model calls, tools and captured HTTP calls. Repeats
    are counted per scope, so branches that send the same request at the same time each get their own
    recorded answer on replay, whatever order they arrive in. Scopes nest (``researcher/search``) and
    follow asyncio tasks created inside the block; a thread started inside needs
    ``contextvars.copy_context()``. Outside Shadowlap it only sets the variable.
    """
    parent = current_scope()
    full = "%s/%s" % (parent, name) if parent else name
    token = _SCOPE.set(full)
    try:
        yield full
    finally:
        _SCOPE.reset(token)


def current_scope() -> Optional[str]:
    return _SCOPE.get() or _base_scope()


def _post(cfg: tuple, path: str, body: dict) -> dict:
    url, run_id = cfg
    # JSON has no NaN or Infinity, and the sidecar refuses a body with them: what reaches here has been
    # made JSON already (see _json_form), and anything else fails here rather than at the sidecar.
    data = json.dumps(body, allow_nan=False).encode("utf-8")
    headers = {"content-type": "application/json"}
    if run_id:
        headers["x-shadowlap-run"] = run_id
    scope_now = current_scope()
    if scope_now:
        headers["x-shadowlap-scope"] = scope_now
    req = urllib.request.Request(url + path, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            message = json.loads(text).get("error", {}).get("message", text)
        except Exception:
            message = text
        raise RuntimeError(f"shadowlap sidecar {path} failed ({e.code}): {message}") from None


def serialize_error(err: BaseException) -> dict:
    out = {"name": type(err).__name__, "message": str(err)}
    code = getattr(err, "code", None)
    if isinstance(code, str):
        out["code"] = code
    return out


# The process is stopping (Ctrl-C, sys.exit()): that is not the tool's answer, so the call is left
# as the run left it rather than recorded as the tool's error.
_STOPPING = (KeyboardInterrupt, SystemExit)


def _cancelled_error(err: BaseException) -> dict:
    """A cancelled call as it is recorded: ``data.cancelled`` is true when the caller cancelled it (a
    deadline in ``asyncio.wait_for``, a task cancelled), false when the tool raised CancelledError
    from an awaitable of its own. Before Python 3.11 a task can't tell, and the caller is assumed."""
    out = serialize_error(err)
    task = asyncio.current_task()
    cancelling = getattr(task, "cancelling", None)
    out["data"] = {"cancelled": bool(cancelling()) if callable(cancelling) else True}
    return out


def _cancellation(error: dict) -> Optional[bool]:
    """Whether a recorded error is a cancellation: True when the caller cancelled the call, False when
    the tool raised CancelledError itself, None when it is an ordinary error. A CancelledError
    recorded before cancellations were marked is taken as the caller's."""
    data = error.get("data")
    flag = data.get("cancelled") if isinstance(data, dict) else None
    if isinstance(flag, bool):
        return flag
    return True if error.get("name") == "CancelledError" else None


async def _replay_cancellation(error: dict) -> None:
    """A replayed cancellation. The caller cancelled the call while it was recorded, so the replay
    waits until the caller cancels it again, as its deadline or cancel did then: the agent takes the
    path it took. A CancelledError the tool raised itself is raised again as one."""
    cancelled = _cancellation(error)
    if cancelled:
        await asyncio.get_running_loop().create_future()  # never resolves; the caller's cancel ends it
    if cancelled is False:
        message = error.get("message")
        raise asyncio.CancelledError(*([message] if message else []))


def _impl_hash(fn: Callable[..., Any]) -> str:
    try:
        source = inspect.getsource(fn)
    except (OSError, TypeError):
        source = getattr(getattr(fn, "__code__", None), "co_code", b"")
        if isinstance(source, bytes):
            return hashlib.sha256(source).hexdigest()
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


# Parameters frameworks fill in themselves: run contexts, configs, injected graph state, callback
# managers. They are neither JSON nor part of what the tool was asked to do, so they are never
# recorded. Matched by the annotation's text, so no framework needs to be importable here.
_CONTEXT_ANNOTATION = re.compile(
    r"\b(RunContext|RunContextWrapper|ToolContext|RunnableConfig|ToolRuntime|Injected[A-Za-z]*|"
    r"(Async)?CallbackManagerForToolRun)\b"
)


def context_params(fn: Callable[..., Any]) -> tuple:
    """The parameters of `fn` that a framework injects: annotated with a Pydantic AI `RunContext`,
    an OpenAI Agents `RunContextWrapper` or `ToolContext`, a LangChain `RunnableConfig`, callback
    manager or `Injected…` marker, or a LangChain `ToolRuntime`."""
    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return ()
    out = []
    for p in params:
        if p.annotation is inspect.Parameter.empty:
            continue
        text = p.annotation if isinstance(p.annotation, str) else repr(p.annotation)
        if _CONTEXT_ANNOTATION.search(text):
            out.append(p.name)
    return tuple(out)


def _bind_args(fn: Callable[..., Any], args: tuple, kwargs: dict, exclude: tuple = ()) -> dict:
    """Tool arguments are recorded by name, however the tool was called. `exclude` drops
    framework context parameters that are neither JSON nor part of the call's identity."""
    try:
        bound = inspect.signature(fn).bind(*args, **kwargs)
        bound.apply_defaults()
        return {k: v for k, v in bound.arguments.items() if k not in exclude}
    except (TypeError, ValueError):
        return {"args": list(args), "kwargs": {k: v for k, v in kwargs.items() if k not in exclude}}


def _is_json(value: Any) -> bool:
    try:
        json.dumps(value, allow_nan=False)
        return True
    except (TypeError, ValueError):
        return False


def _finite(value: Any, path: Optional[set] = None) -> Any:
    """``value`` with every NaN and Infinity replaced by None, as JSON (and the TypeScript SDK's
    ``JSON.stringify``) records them: null. A container inside itself is left for json to refuse."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if not isinstance(value, (dict, list, tuple)):
        return value
    path = set() if path is None else path
    if id(value) in path:
        return value
    path.add(id(value))
    try:
        if isinstance(value, dict):
            return {k: _finite(v, path) for k, v in value.items()}
        return [_finite(v, path) for v in value]
    finally:
        path.discard(id(value))


def _json_form(value: Any) -> Any:
    """``value`` as it is recorded. JSON as it is, a NaN or Infinity as None; a Pydantic model or a
    dataclass as its JSON form. Raises TypeError for anything else."""
    if _is_json(value):
        return value
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        converted = dump(mode="json")
    else:
        import dataclasses

        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            converted = dataclasses.asdict(value)
        elif isinstance(value, tuple):
            converted = [_json_form(v) for v in value]
        else:
            converted = value
    converted = _finite(converted)
    if not _is_json(converted):
        raise TypeError(type(value).__name__)
    return converted


def _check_args(tool_name: str, args: dict) -> dict:
    """The arguments as they are recorded. Fails before the tool runs, naming the argument, when
    something can't be recorded."""
    if _is_json(args):
        return args
    out = {}
    for key, value in args.items():
        out[key] = _finite(value)
        if not _is_json(out[key]):
            raise TypeError(
                f"tool {tool_name}: argument {key!r} ({type(value).__name__}) can't be recorded because it isn't JSON. "
                f"If a framework passes it in, leave it out with @tool(..., exclude=({key!r},))."
            )
    return out


def _recordable(tool_name: str, value: Any) -> Any:
    """A result as JSON: Pydantic models and dataclasses are converted, a NaN or Infinity is None, and
    anything else must already be JSON. A replay returns this JSON form."""
    try:
        return _json_form(value)
    except TypeError:
        raise TypeError(f"tool {tool_name}: its result ({type(value).__name__}) can't be recorded because it isn't JSON; return a str, number, list or dict") from None


def _complete_ok(complete: Callable[..., None], cfg: tuple, call_no: int, tool_name: str, result: Any, latency: int) -> None:
    """Completes a call that returned. When its result can't be recorded, or the sidecar refuses it, the
    call is completed as an error before that is raised: a call left pending is a hole in the
    recording, a tool that ran with no answer for the replay."""
    try:
        complete(cfg, call_no, {"outcome": "ok", "result": _recordable(tool_name, result), "latencyMs": latency})
    except Exception as err:
        with contextlib.suppress(Exception):
            complete(cfg, call_no, {"outcome": "error", "error": serialize_error(err), "latencyMs": latency})
        raise


def tool(
    name: Optional[str] = None,
    *,
    effect: str,
    on_fork: Optional[Callable[..., Any]] = None,
    exclude: tuple = (),
) -> Callable[[F], F]:
    """Wraps a tool implementation. `effect` is required: "pure", "read" or "write".

    Arguments and results are recorded as JSON; a Pydantic model or dataclass result is recorded,
    and replayed, as its JSON form. Under `--writes stub`, `on_fork(**args)` is returned instead of
    executing a write tool after divergence.

    Parameters a framework injects are left out of the recording automatically: Pydantic AI's
    `RunContext`, the OpenAI Agents SDK's `RunContextWrapper` and `ToolContext`, LangChain's
    `RunnableConfig`, callback managers and `Injected…` arguments. `exclude` names any others:

        @agent.tool
        @tool(effect="read")
        async def search_web(ctx: RunContext[Deps], query: str) -> dict: ...
    """
    if effect not in _EFFECTS:
        raise TypeError(f'effect must be "pure", "read" or "write", not {effect!r}')
    explicit = tuple(exclude)

    def decorate(fn: F) -> F:
        tool_name = name or fn.__name__
        impl_hash = _impl_hash(fn)
        exclude = explicit + tuple(p for p in context_params(fn) if p not in explicit)

        def resolve(cfg: tuple, args: dict) -> dict:
            return _post(cfg, "/v1/calls/resolve", {"kind": "tool", "name": tool_name, "effect": effect, "args": args, "implHash": impl_hash})

        def complete(cfg: tuple, call_no: int, body: dict) -> None:
            _post(cfg, f"/v1/calls/{call_no}/complete", body)

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                cfg = _config()
                if cfg is None:
                    return await fn(*args, **kwargs)
                bound = _bind_args(fn, args, kwargs, exclude)
                r = await asyncio.to_thread(resolve, cfg, _check_args(tool_name, bound))
                origin = r["origin"]
                if origin == "replayed":
                    if r["outcome"] == "ok":
                        return r.get("result")
                    if r.get("injected"):
                        raise _injected(tool_name, bound, r["injected"], r["error"])
                    await _replay_cancellation(r["error"])
                    raise ReplayedError(r["error"])
                if origin == "blocked":
                    raise ShadowlapWriteBlocked(tool_name, bound, r["error"]["message"])
                if origin not in ("stubbed", "live"):
                    raise _unknown_origin(tool_name, origin)
                if origin == "stubbed":
                    stub = on_fork(**bound) if on_fork else None
                    if inspect.isawaitable(stub):
                        stub = await stub
                    await asyncio.to_thread(_complete_ok, complete, cfg, r["callNo"], tool_name, stub, 0)
                    return stub
                started = time.time()
                try:
                    result = await fn(*args, **kwargs)
                except _STOPPING:
                    raise
                except asyncio.CancelledError as err:
                    # Not the tool's failure: the caller cut the call off. A thread can't be cancelled,
                    # so this completion is sent even if the caller cancels again while it is.
                    await asyncio.to_thread(complete, cfg, r["callNo"], {"outcome": "error", "error": _cancelled_error(err), "latencyMs": int((time.time() - started) * 1000)})
                    raise
                except BaseException as err:
                    await asyncio.to_thread(complete, cfg, r["callNo"], {"outcome": "error", "error": serialize_error(err), "latencyMs": int((time.time() - started) * 1000)})
                    raise
                await asyncio.to_thread(_complete_ok, complete, cfg, r["callNo"], tool_name, result, int((time.time() - started) * 1000))
                return result

            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            cfg = _config()
            if cfg is None:
                return fn(*args, **kwargs)
            bound = _bind_args(fn, args, kwargs, exclude)
            r = resolve(cfg, _check_args(tool_name, bound))
            origin = r["origin"]
            if origin == "replayed":
                if r["outcome"] == "ok":
                    return r.get("result")
                if r.get("injected"):
                    raise _injected(tool_name, bound, r["injected"], r["error"])
                raise ReplayedError(r["error"])
            if origin == "blocked":
                raise ShadowlapWriteBlocked(tool_name, bound, r["error"]["message"])
            if origin not in ("stubbed", "live"):
                raise _unknown_origin(tool_name, origin)
            if origin == "stubbed":
                stub = on_fork(**bound) if on_fork else None
                _complete_ok(complete, cfg, r["callNo"], tool_name, stub, 0)
                return stub
            started = time.time()
            try:
                result = fn(*args, **kwargs)
            except _STOPPING:
                raise
            except BaseException as err:
                complete(cfg, r["callNo"], {"outcome": "error", "error": serialize_error(err), "latencyMs": int((time.time() - started) * 1000)})
                raise
            _complete_ok(complete, cfg, r["callNo"], tool_name, result, int((time.time() - started) * 1000))
            return result

        return wrapper  # type: ignore[return-value]

    return decorate


def _misc(kind: str, name: str, label: Optional[str], fallback: Callable[[], Any]) -> Any:
    cfg = _config()
    if cfg is None:
        return fallback()
    r = _post(cfg, "/v1/calls/resolve", {"kind": kind, "name": name, "label": label or ""})
    if r.get("outcome") == "error":
        raise ReplayedError(r["error"])
    return r.get("result")


def now(label: Optional[str] = None) -> int:
    """Milliseconds since the epoch; recorded, so a replay sees the recorded value."""
    return int(_misc("clock", "now", label, lambda: int(time.time() * 1000)))


def random(label: Optional[str] = None) -> float:
    """A float in [0, 1), recorded."""
    return float(_misc("random", "random", label, _random.random))


def uuid(label: Optional[str] = None) -> str:
    """A UUID v4 string, recorded."""
    return str(_misc("random", "uuid", label, lambda: str(_uuid.uuid4())))


def _input_preload():
    """Shadowlap's recorded-input preload, when `shadowlap run` loaded it into this process."""
    module = sys.modules.get("_shadowlap_input")
    return module if getattr(module, "active", False) else None


def _answer_text(result: Any) -> str:
    """The text of a recorded answer: ``{"text": ...}``, or a bare string from an override."""
    if isinstance(result, str):
        return result
    if isinstance(result, dict) and isinstance(result.get("text"), str):
        return result["text"]
    return "" if result is None else json.dumps(result)


def _resolve_input(cfg: tuple, prompt: str) -> dict:
    return _post(cfg, "/v1/calls/resolve", {"kind": "tool", "name": "user_input", "effect": "read", "args": {"prompt": prompt}, "input": True})


def _replayed_answer(r: dict) -> str:
    if r["outcome"] == "ok":
        return _answer_text(r.get("result"))
    if (r.get("error") or {}).get("name") == "EOFError":
        raise EOFError((r.get("error") or {}).get("message") or "end of input")
    raise ReplayedError(r["error"])


def user_input(prompt: str = "", read: Optional[Callable[[str], str]] = None) -> str:
    """Asks the person running the agent and records the answer as a ``user_input`` call.

    The call has effect read, the prompt as its argument and ``{"text": answer}`` as its result. A
    replay serves the answer from the recording, and after a fork the recorded answers are served
    in order, so ``shadowlap test``, ``blame`` and ``verify`` run the agent with no one there to type.
    ``read(prompt)`` gets the answer however the agent does (a chat window, a message from a queue);
    by default it is ``input()``. Outside Shadowlap this just calls ``read``.

    ``input()`` and reads of ``sys.stdin`` are recorded without this, by the preload ``shadowlap run``
    adds; use it for input that arrives any other way.
    """
    preload = _input_preload()
    reader = read or (preload.original_input if preload else builtins.input)
    cfg = _config()
    if cfg is None:
        return reader(prompt)
    r = _resolve_input(cfg, prompt)
    if r["origin"] == "replayed":
        return _replayed_answer(r)
    if r["origin"] != "live":
        raise RuntimeError(f"unexpected origin {r['origin']} for user input")
    started = time.time()
    try:
        # A read through input() inside is not recorded a second time.
        with preload.passthrough() if preload else contextlib.nullcontext():
            text = reader(prompt)
    except _STOPPING:
        raise
    except BaseException as err:
        _post(cfg, f"/v1/calls/{r['callNo']}/complete", {"outcome": "error", "error": serialize_error(err), "latencyMs": int((time.time() - started) * 1000)})
        raise
    _post(cfg, f"/v1/calls/{r['callNo']}/complete", {"outcome": "ok", "result": {"text": text}, "latencyMs": int((time.time() - started) * 1000)})
    return text


async def user_input_async(prompt: str, read: Callable[[str], Any]) -> str:
    """``user_input`` for an asyncio agent: ``read(prompt)`` may be a coroutine function, such as
    ``websocket.recv`` behind a lambda, or ``asyncio.to_thread(input, prompt)``. The sidecar is asked
    off the event loop."""
    cfg = _config()
    if cfg is None:
        answer = read(prompt)
        return await answer if inspect.isawaitable(answer) else answer
    r = await asyncio.to_thread(_resolve_input, cfg, prompt)
    if r["origin"] == "replayed":
        if r["outcome"] != "ok":
            await _replay_cancellation(r.get("error") or {})
        return _replayed_answer(r)
    if r["origin"] != "live":
        raise RuntimeError(f"unexpected origin {r['origin']} for user input")
    started = time.time()
    preload = _input_preload()
    try:
        # The preload's passthrough is a context variable, which asyncio.to_thread() carries into
        # its worker, so input() read there isn't recorded a second time.
        with preload.passthrough() if preload else contextlib.nullcontext():
            answer = read(prompt)
            text = await answer if inspect.isawaitable(answer) else answer
    except _STOPPING:
        raise
    except asyncio.CancelledError as err:
        await asyncio.to_thread(_post, cfg, f"/v1/calls/{r['callNo']}/complete", {"outcome": "error", "error": _cancelled_error(err), "latencyMs": int((time.time() - started) * 1000)})
        raise
    except BaseException as err:
        await asyncio.to_thread(_post, cfg, f"/v1/calls/{r['callNo']}/complete", {"outcome": "error", "error": serialize_error(err), "latencyMs": int((time.time() - started) * 1000)})
        raise
    await asyncio.to_thread(_post, cfg, f"/v1/calls/{r['callNo']}/complete", {"outcome": "ok", "result": {"text": text}, "latencyMs": int((time.time() - started) * 1000)})
    return text
