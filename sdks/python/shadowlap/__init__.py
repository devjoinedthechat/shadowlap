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
_TRUST = ("trusted", "untrusted")


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

    It reads as the recorded error: ``ReplayedError({"name": "KeyError", ...})`` is an instance of a
    subclass named ``KeyError`` in the recorded module, holding the recorded arguments, so ``str()``,
    ``repr()``, ``type(e).__name__``, ``e.args`` and a traceback's last line are what they were when
    the call was recorded. An agent that hands a tool's error to the model hands it the same text on
    replay, and ``except ReplayedError`` still catches it."""

    def __new__(cls, error: Optional[dict] = None, *args: Any, **kwargs: Any):
        if cls is ReplayedError and isinstance(error, dict):
            module = error.get("module")
            cls = _replayed_class(str(error.get("name") or "Error"), module if isinstance(module, str) else None)
        return super().__new__(cls)

    def __init__(self, error: dict):
        message = error.get("message", "recorded error")
        args = error.get("args")
        # A recording made before arguments were kept, or of an error whose arguments aren't JSON,
        # has the message alone, which is what an error made from one string holds.
        super().__init__(*(args if isinstance(args, list) else [message]))
        self._message = message if isinstance(message, str) else str(message)
        self.name = error.get("name", "Error")
        self.code = error.get("code")
        self.data = error.get("data")

    def __str__(self) -> str:
        # The recorded str(), which the arguments alone don't give back: str(KeyError("A-17")) is
        # "'A-17'", and an OSError's names its errno and file.
        return self._message

    def __reduce__(self):
        # Rebuilt through ReplayedError, which picks the class for the name again: the class itself is
        # made at run time, and pickle would look it up by its name (ValueError) and find another.
        error = {"name": self.name, "message": self._message, "code": self.code, "data": self.data, "args": list(self.args)}
        module = type(self).__module__
        if module != __name__:
            error["module"] = module
        return (ReplayedError, (error,))


_REPLAYED_CLASSES: dict = {}


def _replayed_class(name: str, module: Optional[str] = None) -> type:
    """The ReplayedError subclass for a recorded error's name and module, one per pair. Its module is
    the recorded one, so a traceback names it as it named the original (``myapp.errors.OrderMissing``,
    and ``OrderMissing`` alone for ``__main__`` and builtins). A recording without a module shows a
    builtin's name (ValueError, KeyError) without one, as the builtin is."""
    if module is None:
        builtin = getattr(builtins, name, None)
        module = "builtins" if isinstance(builtin, type) and issubclass(builtin, BaseException) else __name__
    cls = _REPLAYED_CLASSES.get((name, module))
    if cls is None:
        cls = type(name, (ReplayedError,), {"__module__": module, "__qualname__": name, "__doc__": ReplayedError.__doc__})
        _REPLAYED_CLASSES[(name, module)] = cls
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


def _scope_header(scope: str) -> str:
    """A scope as ``x-shadowlap-scope`` carries it. A header holds Latin-1 at most, and a scope can
    have any name, so ``%`` and every character outside printable ASCII is percent-encoded (UTF-8);
    ``/`` stays the separator, and an ASCII name without ``%`` is sent as it is. The sidecar decodes it."""
    from urllib.parse import quote

    return "".join(c if " " <= c <= "~" and c != "%" else quote(c.encode("utf-8", "replace"), safe="") for c in scope)


# The sidecar is on this machine's loopback: never reached through a proxy (HTTP_PROXY), which would
# see the call in clear text, its session token in the URL, and can't reach the loopback anyway.
_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


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
        headers["x-shadowlap-scope"] = _scope_header(scope_now)
    req = urllib.request.Request(url + path, data=data, headers=headers, method="POST")
    try:
        with _DIRECT.open(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            message = json.loads(text).get("error", {}).get("message", text)
        except Exception:
            message = text
        raise RuntimeError(f"shadowlap sidecar {path} failed ({e.code}): {message}") from None


def serialize_error(err: BaseException) -> dict:
    """An error as it is recorded: its class's name, ``str()`` as the message, a string ``code``, and,
    so a replay prints as it did (``repr()``, a traceback), the class's module unless it is a builtin,
    and its arguments when they aren't the message alone and survive JSON as they are."""
    message = str(err)
    out: dict = {"name": type(err).__name__, "message": message}
    code = getattr(err, "code", None)
    if isinstance(code, str):
        out["code"] = code
    module = getattr(type(err), "__module__", None)
    if isinstance(module, str) and module != "builtins":
        out["module"] = module
    args = getattr(err, "args", ())
    if isinstance(args, tuple) and list(args) != [message]:
        try:
            kept = json.loads(json.dumps(list(args), allow_nan=False))
        except (TypeError, ValueError, RecursionError):
            kept = None
        # Only what JSON gives back unchanged: a tuple would come back a list, and print as one.
        if kept == list(args) and _same_types(kept, list(args)):
            out["args"] = kept
    return out


def _same_types(a: Any, b: Any) -> bool:
    """Whether JSON gave ``b`` back as ``a`` with the same types all through (1 == 1.0 == True)."""
    if type(a) is not type(b):
        return False
    if isinstance(a, list):
        return len(a) == len(b) and all(_same_types(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_same_types(a[k], b[k]) for k in a)
    return True


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
# recorded. Matched by the names of the annotation's types, so no framework needs to be importable
# here; never by its text, which for Annotated includes descriptions that may name these types.
_CONTEXT_TYPE = re.compile(
    r"^(RunContext|RunContextWrapper|ToolContext|RunnableConfig|ToolRuntime|Injected[A-Za-z]*|"
    r"(Async)?CallbackManagerForToolRun)$"
)
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_QUOTED = re.compile(r"(['\"]).*?\1")


def _type_names(annotation: Any, depth: int = 0) -> Iterator[str]:
    """The names of the types an annotation is made of: the class, a generic's origin and its type
    arguments, and the classes of Annotated's metadata. Annotated's strings are descriptions, a
    Literal's arguments are values, and a string annotation's quoted literals are left out with them."""
    import typing

    if depth > 10:
        return
    if isinstance(annotation, typing.ForwardRef):
        annotation = annotation.__forward_arg__
    if isinstance(annotation, str):
        for name in _IDENTIFIER.findall(_QUOTED.sub("", annotation)):
            yield name
        return
    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)
    if origin is typing.Annotated:
        yield from _type_names(args[0], depth + 1)
        for meta in args[1:]:
            if isinstance(meta, str):
                continue
            yield meta.__name__ if isinstance(meta, type) else type(meta).__name__
        return
    if _is_literal(origin):
        return  # Literal["InjectedFile", "Upload"]: values the argument takes, not types
    if isinstance(annotation, type):
        yield annotation.__name__
    elif origin is not None:
        yield from _type_names(origin, depth + 1)
    for arg in args:
        yield from _type_names(arg, depth + 1)


def _is_literal(origin: Any) -> bool:
    """typing.Literal, or typing_extensions' own where it is another object."""
    import typing

    return origin is not None and (origin is typing.Literal or getattr(origin, "_name", None) == "Literal" or repr(origin).endswith(".Literal"))


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
        try:
            if any(_CONTEXT_TYPE.match(name) for name in _type_names(p.annotation)):
                out.append(p.name)
        except Exception:  # an annotation no typing helper understands is no framework's context
            continue
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


def _jsonable(value: Any, path: set) -> Any:
    """``value`` converted, recursively, by the rules in ``_json_form``; whatever has no rule is
    left as it is, for the caller's check to refuse."""
    import dataclasses
    import datetime
    import decimal
    import enum

    if value is None or isinstance(value, str) and not isinstance(value, enum.Enum):
        return value
    if isinstance(value, enum.Enum):
        return _jsonable(value.value, path)
    if isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (datetime.date, datetime.time)):  # datetime is a date
        return value.isoformat()
    if isinstance(value, (_uuid.UUID, decimal.Decimal)):
        return str(value)
    if id(value) in path:
        return value  # inside itself: json refuses it
    path.add(id(value))
    try:
        if isinstance(value, dict):
            return {k: _jsonable(v, path) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [_jsonable(v, path) for v in value]
        if isinstance(value, (set, frozenset)):
            items = [_jsonable(v, path) for v in value]
            try:
                return sorted(items)  # a set's order changes from one process to the next
            except TypeError:
                return items
        dump = getattr(value, "model_dump", None)
        if callable(dump) and not isinstance(value, type):
            return _jsonable(dump(mode="json"), path)
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            return _jsonable(dataclasses.asdict(value), path)
        try:
            from pydantic_core import to_jsonable_python
        except ImportError:
            return value
        try:
            return _jsonable(to_jsonable_python(value), path)
        except Exception:
            return value
    finally:
        path.discard(id(value))


def _json_form(value: Any) -> Any:
    """``value`` as it is recorded, for arguments and results alike: JSON as it is, a NaN or Infinity
    as None, a Pydantic model as ``model_dump(mode="json")``, a dataclass as ``dataclasses.asdict``,
    a date, time or datetime as its ISO 8601 text, a UUID or Decimal as its text, an Enum as its
    value, a set as a sorted list, and whatever else pydantic_core turns into JSON when it is
    installed. Raises TypeError for anything else."""
    if _is_json(value):
        return value
    converted = _jsonable(value, set())
    if not _is_json(converted):
        raise TypeError(type(value).__name__)
    return converted


def _check_args(tool_name: str, args: dict) -> dict:
    """The arguments as they are recorded, by the rules results follow (``_json_form``). Fails before
    the tool runs, naming the argument, when something can't be recorded."""
    if _is_json(args):
        return args
    out = {}
    for key, value in args.items():
        try:
            out[key] = _json_form(value)
        except TypeError:
            raise TypeError(
                f"tool {tool_name}: argument {key!r} ({type(value).__name__}) can't be recorded: it isn't JSON, "
                f"a Pydantic model, a dataclass or a date. If it is a framework's context object, not part of what "
                f"the tool was asked to do, leave it out with @tool(..., exclude=({key!r},)); otherwise pass it as one of those."
            ) from None
    return out


def _string_keys(tool_name: str, value: Any, path: str = "result") -> None:
    """Refuses a dict key that isn't a string. JSON keeps it only as a string, so a replay would hand
    the agent {"2026": 5} where the tool returned {2026: 5}, and the agent's lookups would fail."""
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                as_json = next(iter(json.loads(json.dumps({key: None}))))
                raise TypeError(
                    f"tool {tool_name}: {path} has the key {key!r} ({type(key).__name__}), which JSON keeps only as the string "
                    f"{as_json!r}, so a replay would return that instead; use string keys"
                )
            _string_keys(tool_name, item, f"{path}[{key!r}]")
    elif isinstance(value, (list, tuple)):
        for i, item in enumerate(value):
            _string_keys(tool_name, item, f"{path}[{i}]")


def _recordable(tool_name: str, value: Any) -> Any:
    """A result as JSON: Pydantic models and dataclasses are converted, a NaN or Infinity is None, and
    anything else must already be JSON. A replay returns this JSON form. A dict key that isn't a string
    is refused, since JSON would turn it into one and the replay would return something else."""
    try:
        converted = _json_form(value)
    except TypeError:
        raise TypeError(f"tool {tool_name}: its result ({type(value).__name__}) can't be recorded because it isn't JSON; return a str, number, list or dict") from None
    _string_keys(tool_name, converted)
    return converted


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
    trust: Optional[str] = None,
) -> Callable[[F], F]:
    """Wraps a tool implementation. `effect` is required: "pure", "read" or "write".

    `trust="untrusted"` marks a read that brings outside text in (a web page, an email, a document):
    it is recorded on each call, and `shadowlap injection` plants payloads in what it returns. It
    never changes how a call is matched, so marking a tool keeps its recordings.

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
    if trust is not None and trust not in _TRUST:
        raise TypeError(f'trust must be "trusted" or "untrusted", not {trust!r}')
    explicit = tuple(exclude)
    # Sent only for a tool that brings outside text in.
    marked = {"trust": "untrusted"} if trust == "untrusted" else {}

    def decorate(fn: F) -> F:
        tool_name = name or fn.__name__
        impl_hash = _impl_hash(fn)
        exclude = explicit + tuple(p for p in context_params(fn) if p not in explicit)

        def resolve(cfg: tuple, args: dict) -> dict:
            return _post(cfg, "/v1/calls/resolve", {"kind": "tool", "name": tool_name, "effect": effect, "args": args, "implHash": impl_hash, **marked})

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
