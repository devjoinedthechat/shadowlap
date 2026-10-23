"""A smolagents agent: a ToolCallingAgent on its OpenAI-compatible model, whose model calls go to
whatever OPENAI_BASE_URL names (the sidecar, in front of a scripted Chat Completions API), with
smolagents' @tool over functions wrapped by shadowlap.tool. QUERY is the user's request, so a replay
with another forks at the first model call. Prints a JSON summary."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from smolagents import OpenAIServerModel, ToolCallingAgent  # noqa: E402
from smolagents import tool as smol_tool  # noqa: E402

from shadowlap import tool  # noqa: E402

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@smol_tool
@tool(effect="read", trust="untrusted")
def search_web(query: str) -> str:
    """Search the web for a query.

    Args:
        query: What to search for.
    """
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"]})


@smol_tool
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
    model = OpenAIServerModel(model_id="gpt-5", api_key="test-key")
    agent = ToolCallingAgent(tools=[search_web, send_email], model=model, max_steps=4, verbosity_level=0)
    answer = agent.run(f"Research {QUERY} and email the team.")
    results = [{"observations": step.observations} for step in agent.memory.steps if getattr(step, "observations", None)]
    errors = [str(step.error) for step in agent.memory.steps if getattr(step, "error", None)]
    return {"answer": str(answer), "executed": executed, "results": results, "errors": errors}


if __name__ == "__main__":
    print(json.dumps(main(), default=str))
