"""The agents behind the traces in fixtures/traces, on the Anthropic SDK for Python, each handing a
reply's blocks back as the SDK returned them ("content": reply.content): `support`, the agent of
otel-genai.json (trace-agent.mjs in TypeScript), and `refund`, the agent of the Phoenix and Logfire
fixtures. Replaying one against an imported trace shows which of its calls the trace could serve.

    python trace_agent.py support|refund

Prints the answer on stdout. The SDK is imported from the repository.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

import anthropic  # noqa: E402

from shadowlap import ShadowlapWriteBlocked, tool  # noqa: E402

ORDER_ID = {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}
AGENTS = {
    "support": {
        "request": {
            "model": "claude-haiku-4-5",
            "max_tokens": 512,
            "system": "You are a support agent. Look the order up before you answer.",
            "tools": [{"name": "lookup_order", "description": "Look an order up by its id.", "input_schema": ORDER_ID}],
            # anthropic 2 takes no temperature argument; in the body, it is sent by every release.
            "extra_body": {"temperature": 0},
        },
        "question": "Where is my order A-1042?",
        # It sent its tool results back as compact JSON.
        "separators": (",", ":"),
    },
    "refund": {
        "request": {
            "model": "claude-sonnet-5",
            "max_tokens": 1024,
            "system": "You are a support agent. Follow the refund policy.",
            "tools": [
                {"name": "lookup_order", "description": "Find an order by its id", "input_schema": ORDER_ID},
                {
                    "name": "issue_refund",
                    "description": "Refund an order",
                    "input_schema": {"type": "object", "properties": {"order_id": {"type": "string"}, "amount": {"type": "number"}}, "required": ["order_id", "amount"]},
                },
            ],
        },
        "question": "Customer asks for a refund of order A-1042.",
        "separators": None,
    },
}


@tool(effect="read")
def lookup_order(order_id):
    return {"order_id": order_id, "amount": 240, "status": "delivered", "source": "ran live"}


@tool(effect="write")
def issue_refund(order_id, amount):
    return {"refunded": amount, "order_id": order_id, "source": "ran live"}


TOOLS = {"lookup_order": lookup_order, "issue_refund": issue_refund}


def main():
    agent = AGENTS[sys.argv[1]]
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY") or "test-key", max_retries=0)
    messages = [{"role": "user", "content": agent["question"]}]
    for _ in range(5):
        reply = client.messages.create(messages=messages, **agent["request"])
        messages.append({"role": "assistant", "content": reply.content})
        uses = [b for b in reply.content if b.type == "tool_use"]
        if not uses:
            print("answer: " + "".join(b.text for b in reply.content if b.type == "text"))
            return
        results = []
        for use in uses:
            try:
                out = TOOLS[use.name](**use.input)
            except ShadowlapWriteBlocked as err:
                out = {"error": str(err)}
            results.append({"type": "tool_result", "tool_use_id": use.id, "content": json.dumps(out, separators=agent["separators"])})
        messages.append({"role": "user", "content": results})


main()
