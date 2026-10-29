"""CrewAI: wrap a tool instance.

    from crewai.tools import tool
    from shadowlap.adapters.crewai import with_effect

    @tool("Search the web")
    def search_web(query: str) -> str:
        \"\"\"Search the web for a query.\"\"\"
        ...

    agent = Agent(..., tools=[with_effect(search_web, "read"), with_effect(send_email, "write")])

Works on tools made with `@tool` (their function is wrapped) and on `BaseTool` subclasses (their
`_run` and `_arun`). CrewAI validates the arguments first, so the recording holds what the agent
asked for. Each call is recorded under the name CrewAI shows the model, which it makes from the
tool's own name ("Search the web" is search_the_web), so a replay matches the model's calls to
what was recorded.
"""

from __future__ import annotations

from typing import Any, Callable, Optional, TypeVar

from shadowlap import tool

__all__ = ["with_effect"]

T = TypeVar("T")


def with_effect(crew_tool: T, effect: str, *, on_fork: Optional[Callable[..., Any]] = None, exclude: tuple[str, ...] = (), trust: Optional[str] = None) -> T:
    """Records and replays a CrewAI tool instance as `effect`, and returns the same instance."""
    t: Any = crew_tool
    name = _model_name(getattr(t, "name", None) or type(t).__name__)
    wrap = tool(name, effect=effect, on_fork=on_fork, exclude=exclude, trust=trust)
    func = getattr(t, "func", None)
    if callable(func):
        object.__setattr__(t, "func", wrap(func))
        return crew_tool
    touched = False
    for attr in ("_run", "_arun"):
        method = getattr(t, attr, None)
        defined_here = attr in {k for cls in type(t).__mro__ if not cls.__module__.startswith("crewai.") for k in vars(cls)}
        if callable(method) and defined_here:
            object.__setattr__(t, attr, wrap(method))
            touched = True
    if not touched:
        raise TypeError(f"with_effect: {name} has no function or _run method to wrap")
    return crew_tool


def _model_name(name: str) -> str:
    """The name CrewAI gives the model for a tool named `name`, where this CrewAI makes one."""
    try:
        from crewai.utilities.string_utils import sanitize_tool_name
    except ImportError:
        return name
    return str(sanitize_tool_name(name))
