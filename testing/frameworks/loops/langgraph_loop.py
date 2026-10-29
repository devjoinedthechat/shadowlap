"""A LangGraph agent on a real chat model, as a user writes it: LangChain's create_agent, which runs
LangGraph's ToolNode, on ChatOpenAI. Nothing here names Shadowlap's address: under shadowlap run
the OpenAI SDK's client under ChatOpenAI reads OPENAI_BASE_URL. Tools are LangChain @tool functions
wrapped with shadowlap.adapters.langchain.with_effect. QUERY is the user's request. Prints a JSON
summary, with each ToolMessage as the model read it."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

from langchain.agents import create_agent
from langchain_core.tools import tool as langchain_tool
from langchain_openai import ChatOpenAI

from shadowlap.adapters.langchain import with_effect

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@langchain_tool
def search_web(query: str) -> str:
    """Search the web for a query."""
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"]})


@langchain_tool
def send_email(to: str, body: str) -> str:
    """Send an email."""
    executed.append("send_email")
    return f"sent to {to}"


def main() -> dict:
    model = ChatOpenAI(model="gpt-5")
    agent = create_agent(model, tools=[with_effect(search_web, "read", trust="untrusted"), with_effect(send_email, "write")], system_prompt="Research, then email the team.")
    out = agent.invoke({"messages": [{"role": "user", "content": f"Research {QUERY} and email the team."}]})
    messages = out["messages"]
    results = [{"tool": m.name, "result": str(m.content), "status": m.status} for m in messages if m.type == "tool"]
    return {"answer": str(messages[-1].content), "model": type(model).__name__, "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(main()))
