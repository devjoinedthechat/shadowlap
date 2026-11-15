"""An Agno agent on Agno's default model, as a user writes it: an Agent given no model, so it builds
OpenAIResponses, which calls OpenAI's Responses API and continues each turn from the last with
previous_response_id. Nothing here names shadowlap's address: under shadowlap run the client reads
OPENAI_BASE_URL. Tools are plain functions wrapped by shadowlap.tool. QUERY is the user's request.
Prints a JSON summary."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

from agno.agent import Agent

from shadowlap import tool

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@tool(effect="read", trust="untrusted")
def search_web(query: str) -> str:
    """Search the web for a query.

    Args:
        query: What to search for.
    """
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"]})


@tool(effect="write")
def send_email(to: str, body: str) -> str:
    """Send an email.

    Args:
        to: The address.
        body: The text.
    """
    executed.append("send_email")
    return f"sent to {to}"


def main() -> dict:
    agent = Agent(tools=[search_web, send_email], instructions="Research, then email the team.")
    response = agent.run(f"Research {QUERY} and email the team.")
    results = [{"tool": t.tool_name, "result": str(t.result), "error": bool(t.tool_call_error)} for t in (response.tools or [])]
    return {"answer": str(response.content), "model": type(agent.model).__name__, "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(main(), default=str))
