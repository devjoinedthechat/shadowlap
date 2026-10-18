"""A LangGraph agent (no API) whose tool updates the graph's state by returning a Command, as
LangGraph documents: find_customer, wrapped with shadowlap.adapters.langchain.with_effect, returns
Command(update={"customer": ..., "messages": [ToolMessage(...)]}). The next model node greets the
customer the update put in the state. EMAIL changes the lookup so a replay forks. Prints a JSON
summary."""

import json
import os
import sys
from typing import Annotated, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage  # noqa: E402
from langchain_core.tools import InjectedToolCallId, tool  # noqa: E402
from langgraph.graph import START, MessagesState, StateGraph  # noqa: E402
from langgraph.prebuilt import ToolNode, tools_condition  # noqa: E402
from langgraph.types import Command  # noqa: E402

from shadowlap.adapters.langchain import with_effect  # noqa: E402

EMAIL = os.environ.get("QUERY", "jane@example.com")
executed = []


class State(MessagesState):
    customer: Optional[str]


@tool
def find_customer(email: str, tool_call_id: Annotated[str, InjectedToolCallId]) -> Command:
    """Find the customer with this email and remember them."""
    executed.append("find_customer")
    customer = "cust-for-" + email
    return Command(update={"customer": customer, "messages": [ToolMessage(f"found {customer}", tool_call_id=tool_call_id, artifact={"source": "crm"})]})


@tool
def whoami(tool_call_id: Annotated[str, InjectedToolCallId]) -> ToolMessage:
    """Say who is asking."""
    executed.append("whoami")
    return ToolMessage("an agent", tool_call_id=tool_call_id, name="whoami")


tools = [with_effect(find_customer, "read"), with_effect(whoami, "pure")]


def model(state: State):
    if not any(m.type == "tool" for m in state["messages"]):
        calls = [{"name": "find_customer", "args": {"email": EMAIL}, "id": "call_1"}, {"name": "whoami", "args": {}, "id": "call_2"}]
        return {"messages": [AIMessage("", tool_calls=calls)]}
    return {"messages": [AIMessage("Hello " + str(state.get("customer")))]}


graph = StateGraph(State)
graph.add_node("model", model)
graph.add_node("tools", ToolNode(tools))
graph.add_edge(START, "model")
graph.add_conditional_edges("model", tools_condition)
graph.add_edge("tools", "model")
app = graph.compile()


def main() -> dict:
    out = app.invoke({"messages": [HumanMessage("Greet the customer.")], "customer": None})
    found = next(m for m in out["messages"] if m.type == "tool" and m.tool_call_id == "call_1")
    me = next(m for m in out["messages"] if m.type == "tool" and m.tool_call_id == "call_2")
    return {
        "answer": out["messages"][-1].content,
        "customer": out.get("customer"),
        "tool_message": {"type": type(found).__name__, "content": found.content, "artifact": found.artifact},
        "whoami": {"type": type(me).__name__, "content": me.content, "name": me.name},
        "executed": executed,
    }


if __name__ == "__main__":
    print(json.dumps(main()))
