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
"""

from __future__ import annotations

import functools
import inspect
from typing import Any, Callable, Optional, TypeVar

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


def with_effect(lc_tool: T, effect: str, *, on_fork: Optional[Callable[..., Any]] = None, exclude: tuple = ()) -> T:
    """Records and replays a LangChain tool instance as `effect`, and returns the same instance."""
    t: Any = lc_tool
    name = getattr(t, "name", None) or type(t).__name__
    wrap = tool(name, effect=effect, on_fork=on_fork, exclude=exclude)
    pairs = getattr(t, "response_format", None) == "content_and_artifact"

    def wrapped(fn: Callable[..., Any]) -> Callable[..., Any]:
        w = wrap(fn)
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
