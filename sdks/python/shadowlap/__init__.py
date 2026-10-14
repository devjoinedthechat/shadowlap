"""Shadowlap SDK for Python.

A thin client of the sidecar's call resolution API. No hashing or matching
logic lives here. When Shadowlap is not active (no SHADOWLAP_URL), everything is a passthrough.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import functools
import hashlib
import inspect
import json
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
    "serialize_error",
    "context_params",
    "scope",
    "current_scope",
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
    """A recorded error, replayed. The original class is not preserved; name, message and code are."""

    def __init__(self, error: dict):
        super().__init__(error.get("message", "recorded error"))
        self.name = error.get("name", "Error")
        self.code = error.get("code")
        self.data = error.get("data")

    def __reduce__(self):
        return (type(self), ({"name": self.name, "message": super().__str__(), "code": self.code, "data": self.data},))

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return f"{self.name}: {super().__str__()}"


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
    data = json.dumps(body).encode("utf-8")
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


def _check_args(tool_name: str, args: dict) -> None:
    """Fails before the tool runs, naming the argument, when something can't be recorded."""
    try:
        json.dumps(args)
        return
    except (TypeError, ValueError):
        pass
    for key, value in args.items():
        try:
            json.dumps(value)
        except (TypeError, ValueError):
            raise TypeError(
                f"tool {tool_name}: argument {key!r} ({type(value).__name__}) can't be recorded because it isn't JSON. "
                f"If a framework passes it in, leave it out with @tool(..., exclude=({key!r},))."
            ) from None


def _recordable(tool_name: str, value: Any) -> Any:
    """A result as JSON: Pydantic models and dataclasses are converted, anything else must already be JSON.
    A replay returns this JSON form."""
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        pass
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return dump(mode="json")
    import dataclasses

    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        converted = dataclasses.asdict(value)
        json.dumps(converted)
        return converted
    if isinstance(value, tuple):
        return [_recordable(tool_name, v) for v in value]
    raise TypeError(f"tool {tool_name}: its result ({type(value).__name__}) can't be recorded because it isn't JSON; return a str, number, list or dict")


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
                _check_args(tool_name, bound)
                r = await asyncio.to_thread(resolve, cfg, bound)
                origin = r["origin"]
                if origin == "replayed":
                    if r["outcome"] == "ok":
                        return r.get("result")
                    raise ReplayedError(r["error"])
                if origin == "blocked":
                    raise ShadowlapWriteBlocked(tool_name, bound, r["error"]["message"])
                if origin == "stubbed":
                    stub = on_fork(**bound) if on_fork else None
                    if inspect.isawaitable(stub):
                        stub = await stub
                    await asyncio.to_thread(complete, cfg, r["callNo"], {"outcome": "ok", "result": _recordable(tool_name, stub), "latencyMs": 0})
                    return stub
                started = time.time()
                try:
                    result = await fn(*args, **kwargs)
                except BaseException as err:
                    await asyncio.to_thread(complete, cfg, r["callNo"], {"outcome": "error", "error": serialize_error(err), "latencyMs": int((time.time() - started) * 1000)})
                    raise
                latency = int((time.time() - started) * 1000)
                try:
                    recorded = _recordable(tool_name, result)
                except TypeError as err:
                    await asyncio.to_thread(complete, cfg, r["callNo"], {"outcome": "error", "error": serialize_error(err), "latencyMs": latency})
                    raise
                await asyncio.to_thread(complete, cfg, r["callNo"], {"outcome": "ok", "result": recorded, "latencyMs": latency})
                return result

            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            cfg = _config()
            if cfg is None:
                return fn(*args, **kwargs)
            bound = _bind_args(fn, args, kwargs, exclude)
            _check_args(tool_name, bound)
            r = resolve(cfg, bound)
            origin = r["origin"]
            if origin == "replayed":
                if r["outcome"] == "ok":
                    return r.get("result")
                raise ReplayedError(r["error"])
            if origin == "blocked":
                raise ShadowlapWriteBlocked(tool_name, bound, r["error"]["message"])
            if origin == "stubbed":
                stub = on_fork(**bound) if on_fork else None
                complete(cfg, r["callNo"], {"outcome": "ok", "result": _recordable(tool_name, stub), "latencyMs": 0})
                return stub
            started = time.time()
            try:
                result = fn(*args, **kwargs)
            except BaseException as err:
                complete(cfg, r["callNo"], {"outcome": "error", "error": serialize_error(err), "latencyMs": int((time.time() - started) * 1000)})
                raise
            latency = int((time.time() - started) * 1000)
            try:
                recorded = _recordable(tool_name, result)
            except TypeError as err:
                complete(cfg, r["callNo"], {"outcome": "error", "error": serialize_error(err), "latencyMs": latency})
                raise
            complete(cfg, r["callNo"], {"outcome": "ok", "result": recorded, "latencyMs": latency})
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
