"""Google ADK (``google-adk``): a write refused after a fork reaches the model as the tool's answer.

Tools need no adapter: give ADK plain functions wrapped with ``shadowlap.tool``, and ADK's
``ToolContext`` is left out of the recording. ADK fails the run when a tool raises, though, and under
Shadowlap a write after a fork raises ``ShadowlapWriteBlocked`` (a ``--fail-at`` failure raises too).
Give the agent ``report_to_model`` as its tool-error callback, or the runner the plugin, and the
model reads the refusal as the tool's answer and carries on, as in the other frameworks::

    from shadowlap import tool
    from shadowlap.adapters.google_adk import report_to_model

    @tool(effect="write")
    def send_email(to: str, body: str) -> dict: ...

    agent = LlmAgent(name="support", model="gemini-2.5-flash", tools=[send_email], on_tool_error_callback=report_to_model)
    # or, for every agent the runner runs: Runner(..., plugins=[shadowlap_plugin()])

Any other error is ADK's to handle, as it was.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from shadowlap import ShadowlapInjectedFailure, ShadowlapWriteBlocked

__all__ = ["report_to_model", "shadowlap_plugin"]


def report_to_model(*, error: Exception, **_: Any) -> Optional[Dict[str, Any]]:
    """An ``on_tool_error_callback``: the refusal of a write after a fork, or a failure ``--fail-at``
    injected, as the tool's answer (``{"error": message}``); None for any other error."""
    if isinstance(error, (ShadowlapWriteBlocked, ShadowlapInjectedFailure)):
        return {"error": str(error)}
    return None


def shadowlap_plugin(name: str = "shadowlap") -> Any:
    """An ADK plugin that does what ``report_to_model`` does, for every agent a runner runs."""
    from google.adk.plugins.base_plugin import BasePlugin

    class ShadowlapPlugin(BasePlugin):  # type: ignore[misc]
        async def on_tool_error_callback(self, *, error: Exception, **_: Any) -> Optional[Dict[str, Any]]:
            return report_to_model(error=error)

    return ShadowlapPlugin(name=name)
