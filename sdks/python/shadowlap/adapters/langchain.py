"""LangChain and LangGraph: wrap a tool instance.

    from langchain_core.tools import tool
    from langgraph.prebuilt import ToolNode
    from shadowlap.adapters.langchain import with_effect

    @tool
    def search_web(query: str) -> str:
        \"\"\"Search the web.\"\"\"
        ...

    tools = ToolNode([with_effect(search_web, "read"), with_effect(send_email, "write")])

Works on tools made with `@tool` or `StructuredTool.from_function` (their functions are wrapped)
and on `BaseTool` subclasses (their `_run` and `_arun`). LangChain validates the input first, so the
recording holds the parsed arguments; injected state, tool call ids, configs and callback managers
are left out. The result is recorded before LangChain builds its `ToolMessage`, so a replay gives
back a real `ToolMessage`. A `content_and_artifact` tool's pair is replayed as a tuple again.

A tool that returns a LangGraph `Command`, LangGraph's way for a tool to update the graph's state,
or a message such as a `ToolMessage`, is recorded in a tagged JSON form (messages as
`messages_to_dict` writes them) and rebuilt on replay, so the graph gets a `Command` back and its
state update happens again. While recording, the graph gets the tool's own object.
"""

from __future__ import annotations

import contextvars
import functools
import inspect
from typing import Any, Callable, List, Optional, Tuple, TypeVar, cast

from shadowlap import tool

__all__ = ["with_effect"]

T = TypeVar("T")


def _as_pair(fn: Callable[..., Any]) -> Callable[..., Any]:
    """A recorded (content, artifact) pair comes back from JSON as a list; LangChain wants a tuple."""

    def fix(result: Any) -> Any:
        return tuple(result) if isinstance(result, list) and len(result) == 2 else result

    if inspect.iscoroutinefunction(fn):

        @functools.wraps(fn)
        async def async_pair(*args: Any, **kwargs: Any) -> Any:
            return fix(await fn(*args, **kwargs))

        return async_pair

    @functools.wraps(fn)
    def pair(*args: Any, **kwargs: Any) -> Any:
        return fix(fn(*args, **kwargs))

    return pair


_TAG = "__shadowlap__"


def _langgraph_types() -> Tuple[Any, Any]:
    try:
        from langgraph.types import Command, Send
    except ImportError:
        return None, None
    return Command, Send


def _message_class() -> Optional[type]:
    try:
        from langchain_core.messages import BaseMessage
    except ImportError:
        return None
    return cast(type, BaseMessage)


def _encode_value(value: Any) -> Any:
    """A value inside a Command, with its messages, Sends and tuples tagged so they can be rebuilt."""
    Command, Send = _langgraph_types()
    message = _message_class()
    if message is not None and isinstance(value, message):
        from langchain_core.messages import message_to_dict

        return {_TAG: "message", "message": message_to_dict(value)}
    if Send is not None and isinstance(value, Send):
        return {_TAG: "send", "node": value.node, "arg": _encode_value(value.arg)}
    if Command is not None and isinstance(value, Command):
        return {_TAG: "command", "graph": value.graph, "update": _encode_value(value.update), "resume": _encode_value(value.resume), "goto": _encode_value(value.goto)}
    if isinstance(value, dict):
        return {k: _encode_value(v) for k, v in value.items()}
    if isinstance(value, tuple):
        return {_TAG: "tuple", "items": [_encode_value(v) for v in value]}
    if isinstance(value, list):
        return [_encode_value(v) for v in value]
    return value


def _encode(result: Any) -> Any:
    """A tool's result as it is recorded: a Command or a message tagged, anything else as it is."""
    Command, _ = _langgraph_types()
    message = _message_class()
    if (Command is not None and isinstance(result, Command)) or (message is not None and isinstance(result, message)):
        return _encode_value(result)
    return result


def _decode(value: Any) -> Any:
    """The tagged form back as the objects it was made from."""
    if isinstance(value, list):
        return [_decode(v) for v in value]
    if not isinstance(value, dict):
        return value
    tag = value.get(_TAG)
    if tag == "message":
        from langchain_core.messages import messages_from_dict

        return messages_from_dict([value["message"]])[0]
    if tag == "tuple":
        return tuple(_decode(v) for v in value.get("items", []))
    if tag in ("command", "send"):
        Command, Send = _langgraph_types()
        if Command is None:
            raise RuntimeError("shadowlap: this recording holds a LangGraph Command, and langgraph can't be imported")
        if tag == "send":
            return Send(value["node"], _decode(value.get("arg")))
        return Command(graph=value.get("graph"), update=_decode(value.get("update")), resume=_decode(value.get("resume")), goto=_decode(value.get("goto", ())))
    return {k: _decode(v) for k, v in value.items()}


# The live result of the call in progress: the graph gets the tool's own object while recording, and
# the object rebuilt from the recording on replay.
_LIVE: "contextvars.ContextVar[Optional[List[Any]]]" = contextvars.ContextVar("shadowlap_langchain_live", default=None)


def _with_codec(fn: Callable[..., Any], wrap: Callable[[Callable[..., Any]], Callable[..., Any]]) -> Callable[..., Any]:
    """``wrap(fn)``, with a Command or message result recorded in its tagged form and rebuilt on replay."""
    if inspect.iscoroutinefunction(fn):

        @functools.wraps(fn)
        async def encoded_async(*args: Any, **kwargs: Any) -> Any:
            result = await fn(*args, **kwargs)
            box = _LIVE.get()
            if box is not None:
                box.append(result)
            return _encode(result)

        recorded_async = wrap(encoded_async)

        @functools.wraps(fn)
        async def decoded_async(*args: Any, **kwargs: Any) -> Any:
            box: List[Any] = []
            token = _LIVE.set(box)
            try:
                result = await recorded_async(*args, **kwargs)
            finally:
                _LIVE.reset(token)
            return box[0] if box else _decode(result)

        return decoded_async

    @functools.wraps(fn)
    def encoded(*args: Any, **kwargs: Any) -> Any:
        result = fn(*args, **kwargs)
        box = _LIVE.get()
        if box is not None:
            box.append(result)
        return _encode(result)

    recorded = wrap(encoded)

    @functools.wraps(fn)
    def decoded(*args: Any, **kwargs: Any) -> Any:
        box: List[Any] = []
        token = _LIVE.set(box)
        try:
            result = recorded(*args, **kwargs)
        finally:
            _LIVE.reset(token)
        return box[0] if box else _decode(result)

    return decoded


def with_effect(lc_tool: T, effect: str, *, on_fork: Optional[Callable[..., Any]] = None, exclude: Tuple[str, ...] = (), trust: Optional[str] = None) -> T:
    """Records and replays a LangChain tool instance as `effect`, and returns the same instance."""
    t: Any = lc_tool
    name = getattr(t, "name", None) or type(t).__name__
    wrap = tool(name, effect=effect, on_fork=on_fork, exclude=exclude, trust=trust)
    pairs = getattr(t, "response_format", None) == "content_and_artifact"

    def wrapped(fn: Callable[..., Any]) -> Callable[..., Any]:
        w = _with_codec(fn, wrap)
        return _as_pair(w) if pairs else w

    touched = False
    for attr in ("func", "coroutine"):
        fn = getattr(t, attr, None)
        if callable(fn):
            object.__setattr__(t, attr, wrapped(fn))
            touched = True
    if not touched:
        # A BaseTool subclass: its own _run / _arun, bound to the instance.
        for attr in ("_run", "_arun"):
            method = getattr(t, attr, None)
            defined_here = attr in {k for cls in type(t).__mro__ if cls.__module__.split(".")[0] != "langchain_core" for k in vars(cls)}
            if callable(method) and defined_here:
                object.__setattr__(t, attr, wrapped(method))
                touched = True
    if not touched:
        raise TypeError(f"with_effect: {name} has no function or _run method to wrap")
    return lc_tool
