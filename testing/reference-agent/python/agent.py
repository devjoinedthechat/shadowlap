"""The reference agent in Python: the same 30-call research scenario as the TypeScript one, driven
by the real `anthropic` SDK (streaming, parallel tool calls) and the Shadowlap Python SDK.

    pip install anthropic
    shadowlap run -- python testing/reference-agent/python/agent.py        # against the real API, or
    SHADOWLAP_UPSTREAM_ANTHROPIC=<mock url> shadowlap run -- python testing/reference-agent/python/agent.py

    AGENT_DATE=2026-09-16   adds "Today is …" to the system prompt (change it to see a fork)
    AGENT_SYSTEM_SUFFIX="…" appends to the system prompt, as the TypeScript agent does (forks at call 3)

Prints a JSON summary on stdout; progress on stderr. The SDK is imported from the repository so the
script runs without installing it; `pip install shadowlap` works the same way.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

import anthropic  # noqa: E402

from shadowlap import ShadowlapWriteBlocked, now, tool, uuid  # noqa: E402

MODEL = os.environ.get("AGENT_MODEL", "claude-opus-5")
TOOLS = [
    {"name": "search_web", "description": "Search the web.", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "read_file", "description": "Read a local file.", "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
    {"name": "fetch_page", "description": "Fetch a page.", "input_schema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}},
    {
        "name": "send_email",
        "description": "Send an email.",
        "input_schema": {"type": "object", "properties": {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}, "required": ["to", "subject", "body"]},
    },
]


def log(line: str) -> None:
    sys.stderr.write(f"[agent] {line}\n")


@tool(effect="read")
def search_web(query: str) -> dict:
    return {"results": [{"title": f"{query} #{i}", "url": f"https://example.com/{i}"} for i in range(1, 4)]}


@tool(effect="pure")
def read_file(path: str) -> dict:
    return {"path": path, "content": f"contents of {path}"}


@tool(effect="read")
def fetch_page(url: str) -> dict:
    return {"url": url, "status": 200, "text": f"page at {url}"}


@tool(effect="write", on_fork=lambda to, subject, body: {"sent": False, "suppressed": True, "to": to})
def send_email(to: str, subject: str, body: str) -> dict:
    return {"sent": True, "to": to, "message_id": f"msg_{len(subject)}"}


IMPL = {"search_web": search_web, "read_file": read_file, "fetch_page": fetch_page, "send_email": send_email}


def main() -> dict:
    started_at = now()
    request_id = uuid()
    date = os.environ.get("AGENT_DATE")
    suffix = os.environ.get("AGENT_SYSTEM_SUFFIX")
    system = "You are a research agent. Use the tools, then email a summary." + (f" Today is {date}." if date else "") + (f" {suffix}" if suffix else "")
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", "test-key"), max_retries=2)
    messages = [{"role": "user", "content": f"Research request {request_id}: investigate replay for agents and report back."}]
    model_calls = 0
    tool_calls = 0
    tool_errors = []
    final_text = ""
    for _ in range(20):
        with client.messages.stream(model=MODEL, max_tokens=1024, system=system, tools=TOOLS, messages=messages) as stream:
            message = stream.get_final_message()
        model_calls += 1
        log(f"model call {model_calls}: stop_reason={message.stop_reason}")
        uses = [b for b in message.content if b.type == "tool_use"]
        final_text = "".join(b.text for b in message.content if b.type == "text")
        if message.stop_reason != "tool_use" or not uses:
            break
        messages.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in message.content]})
        results = []
        for use in uses:
            tool_calls += 1
            try:
                result = IMPL[use.name](**use.input)
                results.append({"type": "tool_result", "tool_use_id": use.id, "content": json.dumps(result)})
            except ShadowlapWriteBlocked as err:
                tool_errors.append(f"{use.name}: ShadowlapWriteBlocked")
                log(f"tool {use.name} failed: ShadowlapWriteBlocked: {err}")
                results.append({"type": "tool_result", "tool_use_id": use.id, "content": f"error: {err}", "is_error": True})
            except Exception as err:  # noqa: BLE001
                tool_errors.append(f"{use.name}: {type(err).__name__}")
                log(f"tool {use.name} failed: {type(err).__name__}: {err}")
                results.append({"type": "tool_result", "tool_use_id": use.id, "content": f"error: {err}", "is_error": True})
        messages.append({"role": "user", "content": results})
    return {"finalText": final_text, "modelCalls": model_calls, "toolCalls": tool_calls, "toolErrors": tool_errors, "startedAt": started_at, "requestId": request_id}


if __name__ == "__main__":
    print(json.dumps(main()))
