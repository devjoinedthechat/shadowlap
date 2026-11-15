"""A support chat agent that waits for the customer at the terminal.

Each turn it asks with input(), sends the conversation to the model, and runs the tools the model
asks for: looking an order up, shipping a replacement, issuing a refund. Under shadowlap every answer
the customer types is recorded as a user_input call, so the chat replays, tests and blames with no
one typing. The model is the repository's mock (mock_model.mjs), so nothing here needs an API key.

    python support_chat.py                          talks to ANTHROPIC_BASE_URL directly
    shadowlap run -- python support_chat.py         records the chat (see README.md)

An empty line or Ctrl-D ends the chat.
"""

import json
import os
import urllib.request

from shadowlap import tool

MODEL = os.environ.get("AGENT_MODEL", "claude-haiku-4-5")
SYSTEM = "You are the support agent of a kitchen appliance shop. Look an order up before you act on it, and ask before you refund or replace anything."
ORDERS = {
    "A-1042": {"order_id": "A-1042", "item": "blender", "amount": 240, "status": "delivered"},
    "B-7": {"order_id": "B-7", "item": "kettle", "amount": 40, "status": "delivered"},
}


@tool(effect="read")
def lookup_order(order_id: str) -> dict:
    return ORDERS.get(order_id, {"error": "no such order"})


@tool(effect="write", on_fork=lambda order_id: {"ok": False, "suppressed": True})
def create_replacement(order_id: str) -> dict:
    return {"ok": True, "shipment": "S-5531"}


@tool(effect="write", on_fork=lambda order_id, amount: {"refunded": False, "suppressed": True})
def issue_refund(order_id: str, amount: int) -> dict:
    return {"refunded": True, "order_id": order_id, "amount": amount}


TOOLS = {f.__name__: f for f in (lookup_order, create_replacement, issue_refund)}
ORDER_ID = {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}
TOOL_DEFINITIONS = [
    {"name": "lookup_order", "description": "Look an order up by its id.", "input_schema": ORDER_ID},
    {"name": "create_replacement", "description": "Ship a replacement for an order.", "input_schema": ORDER_ID},
    {"name": "issue_refund", "description": "Refund an order.", "input_schema": {"type": "object", "properties": {"order_id": {"type": "string"}, "amount": {"type": "integer"}}, "required": ["order_id", "amount"]}},
]


def ask_model(messages):
    """One call to the Messages API, at ANTHROPIC_BASE_URL (which `shadowlap run` points at itself)."""
    base = os.environ.get("ANTHROPIC_BASE_URL", "http://127.0.0.1:4100").rstrip("/")
    body = {"model": MODEL, "max_tokens": 512, "system": SYSTEM, "tools": TOOL_DEFINITIONS, "messages": messages}
    request = urllib.request.Request(
        base + "/v1/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": os.environ.get("ANTHROPIC_API_KEY", "not-needed-for-the-mock")},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    messages = []
    prompt = "How can I help? "
    while True:
        try:
            line = input(prompt)
        except EOFError:
            print()
            return
        if not line.strip():
            return
        messages.append({"role": "user", "content": line})
        while True:
            reply = ask_model(messages)
            messages.append({"role": "assistant", "content": reply["content"]})
            for block in reply["content"]:
                if block["type"] == "text":
                    print(block["text"])
            uses = [block for block in reply["content"] if block["type"] == "tool_use"]
            if not uses:
                break
            results = []
            for use in uses:
                try:
                    result = TOOLS[use["name"]](**use["input"])
                except Exception as error:  # a blocked write after a fork, for one
                    result = {"error": str(error)}
                print("  (%s %s)" % (use["name"], json.dumps(result)))
                results.append({"type": "tool_result", "tool_use_id": use["id"], "content": json.dumps(result)})
            messages.append({"role": "user", "content": results})
        prompt = "> "


if __name__ == "__main__":
    main()
