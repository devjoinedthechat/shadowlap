"""A Pydantic AI agent whose tool takes typed arguments, as Pydantic AI documents them: a Pydantic
model and a date. Pydantic AI validates the model's JSON into those types before calling the tool;
shadowlap records them in their JSON form. SUBJECT changes the ticket the model asks for, so a
replay forks. Prints a JSON summary."""

import asyncio
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from shadowlap import tool

SUBJECT = os.environ.get("SUBJECT", "refund A-17")
executed = []


class Ticket(BaseModel):
    subject: str
    priority: str = "normal"


def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    returned = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
    if not returned:
        return ModelResponse(parts=[ToolCallPart("open_ticket", {"ticket": {"subject": SUBJECT, "priority": "high"}, "day": "2026-10-18"}, tool_call_id="call_1")])
    return ModelResponse(parts=[TextPart("Opened: " + "; ".join(str(p.content) for p in returned))])


agent = Agent(FunctionModel(model))


@agent.tool_plain
@tool(effect="read")
def open_ticket(ticket: Ticket, day: datetime.date) -> str:
    executed.append(type(ticket).__name__ + "/" + type(day).__name__)
    return f"{ticket.subject} ({ticket.priority}) on {day.isoformat()}"


async def main() -> dict:
    try:
        result = await agent.run("Open a ticket for the refund.")
        return {"output": result.output, "executed": executed, "error": None}
    except Exception as err:  # what the agent would crash with
        return {"output": None, "executed": executed, "error": f"{type(err).__name__}: {err}"}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main())))
