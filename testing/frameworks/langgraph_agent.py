"""A LangGraph agent (no API): a scripted model node, ToolNode, and three kinds of LangChain tool
wrapped with shadowlap.adapters.langchain.with_effect: a @tool function with injected graph state,
a BaseTool subclass with a run manager, and a content_and_artifact tool. QUERY changes the search
so a replay forks. Prints a JSON summary."""

import json
import os
import sys
from typing import Annotated, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from langchain_core.callbacks import CallbackManagerForToolRun  # noqa: E402
from langchain_core.messages import AIMessage, HumanMessage  # noqa: E402
from langchain_core.tools import BaseTool, tool  # noqa: E402
from langgraph.graph import END, START, MessagesState, StateGraph  # noqa: E402
from langgraph.prebuilt import InjectedState, ToolNode, tools_condition  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from shadowlap import ShadowlapWriteBlocked  # noqa: E402
from shadowlap.adapters.langchain import with_effect  # noqa: E402

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@tool
def search_web(query: str, state: Annotated[dict, InjectedState]) -> str:
    """Search the web."""
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"], "seen": len(state["messages"])})


@tool(response_format="content_and_artifact")
def read_notes(topic: str) -> tuple:
    """Read notes on a topic."""
    executed.append("read_notes")
    return f"notes on {topic}", {"pages": 3}


class EmailInput(BaseModel):
    to: str


class SendEmail(BaseTool):
    name: str = "send_email"
    description: str = "Send an email."
    args_schema: type = EmailInput

    def _run(self, to: str, run_manager: Optional[CallbackManagerForToolRun] = None) -> str:
        executed.append("send_email")
        return f"sent to {to}"


tools = [with_effect(search_web, "read"), with_effect(read_notes, "pure"), with_effect(SendEmail(), "write")]


def model(state: MessagesState):
    results = [m for m in state["messages"] if m.type == "tool"]
    if not results:
        return {"messages": [AIMessage("", tool_calls=[{"name": "search_web", "args": {"query": QUERY}, "id": "call_1"}, {"name": "read_notes", "args": {"topic": "replay"}, "id": "call_2"}])]}
    if len(results) == 2:
        return {"messages": [AIMessage("", tool_calls=[{"name": "send_email", "args": {"to": "team@example.com"}, "id": "call_3"}])]}
    return {"messages": [AIMessage("Done: " + "; ".join(str(m.content) for m in results))]}


graph = StateGraph(MessagesState)
graph.add_node("model", model)
graph.add_node("tools", ToolNode(tools))
graph.add_edge(START, "model")
graph.add_conditional_edges("model", tools_condition)
graph.add_edge("tools", "model")
app = graph.compile()


def main() -> dict:
    try:
        out = app.invoke({"messages": [HumanMessage("Research and email the team.")]})
    except ShadowlapWriteBlocked as err:
        return {"output": None, "artifact": None, "executed": executed, "error": f"ShadowlapWriteBlocked: {err}"}
    messages = out["messages"]
    notes = next(m for m in messages if m.type == "tool" and m.name == "read_notes")
    email = next((m for m in messages if m.type == "tool" and m.name == "send_email"), None)
    return {"output": messages[-1].content, "artifact": notes.artifact, "email": email.content if email else None, "email_status": getattr(email, "status", None), "executed": executed, "error": None}


if __name__ == "__main__":
    print(json.dumps(main()))
