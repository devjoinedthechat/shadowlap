"""A smolagents CodeAgent, its flagship: the model writes Python that calls the tools, run by
smolagents' local executor. On OpenAIModel (also exported as OpenAIServerModel) given only a model
id: its key and base URL come from OPENAI_API_KEY and OPENAI_BASE_URL, which shadowlap run sets.
Or MODEL=inference picks smolagents' default model, InferenceClientModel, which calls Hugging Face's
router with HF_TOKEN.
Tools are functions wrapped by shadowlap.tool under smolagents' @tool. QUERY is the user's request.
Prints a JSON summary."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

from smolagents import CodeAgent, InferenceClientModel, OpenAIModel
from smolagents import tool as smol_tool

from shadowlap import tool

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
    model = InferenceClientModel() if os.environ.get("MODEL") == "inference" else OpenAIModel(model_id="gpt-4.1")
    agent = CodeAgent(tools=[search_web, send_email], model=model, max_steps=4, verbosity_level=0)
    answer = agent.run(f"Research {QUERY} and email the team.")
    errors = [str(step.error) for step in agent.memory.steps if getattr(step, "error", None)]
    return {"answer": str(answer), "model": type(model).__name__, "executed": executed, "errors": errors}


if __name__ == "__main__":
    print(json.dumps(main(), default=str))
