"""A Strands agent on Strands' default model, as a user writes it: an Agent given no model, so it builds
its BedrockModel, which calls Bedrock's ConverseStream through boto3, signed for
bedrock-runtime.<AWS_REGION>.amazonaws.com with credentials from the environment. Nothing here names
shadowlap's address: under shadowlap run the calls are captured in the process. Tools are functions
wrapped by shadowlap.tool under Strands' @tool. QUERY is the user's request. Prints a JSON summary."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

from strands import Agent
from strands import tool as strands_tool

from shadowlap import tool

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
    agent = Agent(tools=[search_web, send_email], system_prompt="Research, then email the team.", callback_handler=None)
    result = agent(f"Research {QUERY} and email the team.")
    results = []
    for message in agent.messages:
        for block in message.get("content", []):
            if "toolResult" in block:
                tr = block["toolResult"]
                results.append({"status": tr.get("status"), "content": [c.get("text") for c in tr.get("content", [])]})
    return {"answer": str(result).strip(), "model": type(agent.model).__name__, "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(main(), default=str))
