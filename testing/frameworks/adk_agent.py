"""A Google ADK agent: an LlmAgent on a Gemini model, run by ADK's Runner with an in-memory session.
Its model calls go to whatever GOOGLE_GEMINI_BASE_URL names (the sidecar, in front of a scripted
Gemini), and its tools are plain functions wrapped with shadowlap.tool, one taking ADK's ToolContext, and a write
refused after a fork reaches the model through shadowlap.adapters.google_adk.report_to_model.
QUERY is the user's request, so a replay with another forks at the first model call. Prints a JSON
summary."""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from google.adk.agents import LlmAgent  # noqa: E402
from google.adk.runners import Runner  # noqa: E402
from google.adk.sessions import InMemorySessionService  # noqa: E402
from google.adk.tools import ToolContext  # noqa: E402
from google.genai import types  # noqa: E402

from shadowlap import tool  # noqa: E402
from shadowlap.adapters.google_adk import report_to_model  # noqa: E402

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@tool(effect="read", trust="untrusted")
async def search_web(query: str, tool_context: ToolContext) -> dict:
    """Search the web for a query."""
    executed.append("search_web")
    return {"results": [f"{query} #1"], "agent": tool_context.agent_name}


@tool(effect="write")
def send_email(to: str, body: str) -> dict:
    """Send an email."""
    executed.append("send_email")
    return {"sent": True, "to": to}


async def main() -> dict:
    agent = LlmAgent(name="researcher", model="gemini-2.5-flash", instruction="Research, then email the team.", tools=[search_web, send_email], on_tool_error_callback=report_to_model)
    sessions = InMemorySessionService()
    session = await sessions.create_session(app_name="shadowlap-test", user_id="u1")
    runner = Runner(agent=agent, app_name="shadowlap-test", session_service=sessions)
    answer, results = None, []
    async for event in runner.run_async(user_id="u1", session_id=session.id, new_message=types.Content(role="user", parts=[types.Part(text=f"Research {QUERY} and email the team.")])):
        for part in (event.content.parts if event.content else []) or []:
            if part.function_response is not None:
                results.append({"name": part.function_response.name, "response": part.function_response.response})
            if part.text and event.is_final_response():
                answer = part.text
    return {"answer": answer, "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main()), default=str))
