"""OpenAI Agents SDK (`openai-agents`): `function_tool` with an effect.

    from shadowlap.adapters.openai_agents import function_tool

    @function_tool(effect="read")
    async def search_web(ctx: RunContextWrapper[Deps], query: str) -> str:
        ...

It is `agents.function_tool` over `shadowlap.tool`: the SDK builds the schema from the original
function, parses and validates the model's arguments, and handles errors as usual. The run context
is left out of the recording. Every other `function_tool` keyword argument passes through.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from shadowlap import tool

__all__ = ["function_tool"]


def function_tool(
    func: Optional[Callable[..., Any]] = None,
    *,
    effect: str,
    on_fork: Optional[Callable[..., Any]] = None,
    trust: Optional[str] = None,
    **kwargs: Any,
) -> Any:
    """`agents.function_tool(...)`, recording and replaying the tool as `effect`. A blocked write
    raises inside the tool, so the SDK reports it to the model like any other tool error."""
    from agents import function_tool as _function_tool

    def decorate(fn: Callable[..., Any]) -> Any:
        name = kwargs.get("name_override") or fn.__name__
        return _function_tool(tool(name, effect=effect, on_fork=on_fork, trust=trust)(fn), **kwargs)

    return decorate(func) if func is not None else decorate
