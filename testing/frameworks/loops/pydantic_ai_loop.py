"""A Pydantic AI agent on a model named by string, as a user writes it: Agent("openai:gpt-5") builds
Pydantic AI's OpenAI model on the OpenAI SDK's client, which calls the Responses API. Nothing here
names shadowlap's address: under shadowlap run the client reads OPENAI_BASE_URL. Tools are
registered with @agent.tool_plain over shadowlap.tool. QUERY is the user's request. Prints a JSON
summary, with each tool's result as the model read it."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

from pydantic_ai import Agent
from pydantic_ai.messages import ToolReturnPart

from shadowlap import tool

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []

agent = Agent("openai:gpt-5", instructions="Research, then email the team.")


@agent.tool_plain
@tool(effect="read", trust="untrusted")
def search_web(query: str) -> str:
    """Search the web for a query."""
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"]})


@agent.tool_plain
@tool(effect="write")
def send_email(to: str, body: str) -> str:
    """Send an email."""
    executed.append("send_email")
    return f"sent to {to}"


def main() -> dict:
    result = agent.run_sync(f"Research {QUERY} and email the team.")
    parts = [p for m in result.all_messages() for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
    results = [{"tool": p.tool_name, "result": str(p.content), "failed": p.outcome == "failed"} for p in parts]
    return {"answer": result.output, "model": type(agent.model).__name__, "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(main()))
