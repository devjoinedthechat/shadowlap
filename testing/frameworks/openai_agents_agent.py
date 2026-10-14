"""An OpenAI Agents SDK agent run by Runner with a scripted Model (no API): the model asks for
search_web, then send_email, then answers. Tools use shadowlap.adapters.openai_agents.function_tool,
with the run context as the first parameter. QUERY changes the search so a replay forks.
Prints a JSON summary."""

import asyncio
import json
import os
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from agents import Agent, RunContextWrapper, Runner, set_tracing_disabled  # noqa: E402
from agents.items import ModelResponse  # noqa: E402
from agents.models.interface import Model  # noqa: E402
from agents.usage import Usage  # noqa: E402
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText  # noqa: E402

from shadowlap.adapters.openai_agents import function_tool  # noqa: E402

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []
set_tracing_disabled(True)


@dataclass
class Deps:
    signature: str


class ScriptedModel(Model):
    async def get_response(self, *args, **kwargs):
        items = kwargs.get("input", args[1] if len(args) > 1 else [])
        outputs = [i for i in (items if isinstance(items, list) else []) if isinstance(i, dict) and i.get("type") == "function_call_output"]
        if not outputs:
            out = [ResponseFunctionToolCall(id="fc_1", call_id="call_1", name="search_web", arguments=json.dumps({"query": QUERY}), type="function_call", status="completed")]
        elif len(outputs) == 1:
            out = [ResponseFunctionToolCall(id="fc_2", call_id="call_2", name="send_email", arguments=json.dumps({"to": "team@example.com"}), type="function_call", status="completed")]
        else:
            text = "Done: " + "; ".join(str(o.get("output")) for o in outputs)
            out = [ResponseOutputMessage(id="msg_1", role="assistant", status="completed", type="message", content=[ResponseOutputText(text=text, type="output_text", annotations=[])])]
        return ModelResponse(output=out, usage=Usage(), response_id=None)

    def stream_response(self, *args, **kwargs):
        raise NotImplementedError


@function_tool(effect="read")
async def search_web(ctx: RunContextWrapper[Deps], query: str) -> str:
    """Search the web."""
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"], "signed": ctx.context.signature})


@function_tool(effect="write")
def send_email(ctx: RunContextWrapper[Deps], to: str) -> str:
    """Send an email."""
    executed.append("send_email")
    return f"sent to {to}"


async def main() -> dict:
    agent = Agent(name="researcher", instructions="Research, then email the team.", tools=[search_web, send_email], model=ScriptedModel())
    result = await Runner.run(agent, "Research and email the team.", context=Deps(signature="ops"))
    return {"output": result.final_output, "executed": executed, "error": None}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main())))
