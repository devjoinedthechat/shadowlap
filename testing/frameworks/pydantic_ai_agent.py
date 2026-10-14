"""A Pydantic AI agent driven by FunctionModel (no API): the model asks for search_web and send_email,
then answers. Tools are registered with @agent.tool over the Shadowlap @tool decorator,
the documented pattern; the RunContext parameter is left out of the recording automatically. QUERY changes the search arguments so a replay forks.
Prints a JSON summary."""

import asyncio
import json
import os
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from pydantic_ai import Agent, RunContext  # noqa: E402
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart  # noqa: E402
from pydantic_ai.models.function import AgentInfo, FunctionModel  # noqa: E402

from shadowlap import ShadowlapWriteBlocked, tool  # noqa: E402

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@dataclass
class Deps:
    signature: str


def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    returned = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
    if not returned:
        return ModelResponse(parts=[ToolCallPart("search_web", {"query": QUERY}, tool_call_id="call_1")])
    if len(returned) == 1:  # email once the search results are in
        return ModelResponse(parts=[ToolCallPart("send_email", {"to": "team@example.com"}, tool_call_id="call_2")])
    return ModelResponse(parts=[TextPart("Done: " + "; ".join(str(p.content) for p in returned))])


agent = Agent(FunctionModel(model), deps_type=Deps)


@agent.tool
@tool(effect="read")
async def search_web(ctx: RunContext[Deps], query: str) -> dict:
    executed.append("search_web")
    return {"results": [f"{query} #1"], "signed": ctx.deps.signature}


@agent.tool
@tool(effect="write")
async def send_email(ctx: RunContext[Deps], to: str) -> dict:
    executed.append("send_email")
    return {"sent": True, "to": to}


async def main() -> dict:
    try:
        result = await agent.run("Research and email the team.", deps=Deps(signature="ops"))
        return {"output": result.output, "executed": executed, "error": None}
    except ShadowlapWriteBlocked as err:
        return {"output": None, "executed": executed, "error": f"ShadowlapWriteBlocked: {err}"}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main())))
