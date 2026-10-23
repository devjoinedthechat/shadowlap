"""An Agno agent: an Agent on Agno's Claude model, whose model calls go to whatever
ANTHROPIC_BASE_URL names (the sidecar, in front of a scripted Anthropic API), with plain functions
wrapped by shadowlap.tool as its tools. QUERY is the user's request, so a replay with another forks
at the first model call. Prints a JSON summary."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from agno.agent import Agent  # noqa: E402
from agno.models.anthropic import Claude  # noqa: E402

from shadowlap import tool  # noqa: E402

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
    agent = Agent(model=Claude(id="claude-opus-5", api_key="test-key", max_tokens=256), tools=[search_web, send_email], instructions="Research, then email the team.")
    response = agent.run(f"Research {QUERY} and email the team.")
    results = [{"tool": t.tool_name, "result": str(t.result), "error": bool(t.tool_call_error)} for t in (response.tools or [])]
    return {"answer": str(response.content), "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(main(), default=str))
