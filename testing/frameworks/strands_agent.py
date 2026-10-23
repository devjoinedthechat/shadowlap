"""A Strands agent: an Agent on Strands' Anthropic model, whose model calls go to whatever
ANTHROPIC_BASE_URL names (the sidecar, in front of a scripted Anthropic API), with Strands' @tool
over functions wrapped by shadowlap.tool. QUERY is the user's request, so a replay with another forks
at the first model call. Prints a JSON summary."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from strands import Agent  # noqa: E402
from strands import tool as strands_tool  # noqa: E402
from strands.models.anthropic import AnthropicModel  # noqa: E402

from shadowlap import tool  # noqa: E402

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@strands_tool
@tool(effect="read", trust="untrusted")
def search_web(query: str) -> str:
    """Search the web for a query.

    Args:
        query: What to search for.
    """
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"]})


@strands_tool
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
    model = AnthropicModel(client_args={"api_key": "test-key", "max_retries": 0}, model_id="claude-opus-5", max_tokens=256)
    agent = Agent(model=model, tools=[search_web, send_email], system_prompt="Research, then email the team.", callback_handler=None)
    result = agent(f"Research {QUERY} and email the team.")
    results = []
    for message in agent.messages:
        for block in message.get("content", []):
            if "toolResult" in block:
                tr = block["toolResult"]
                results.append({"status": tr.get("status"), "content": [c.get("text") for c in tr.get("content", [])]})
    return {"answer": str(result).strip(), "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(main(), default=str))
