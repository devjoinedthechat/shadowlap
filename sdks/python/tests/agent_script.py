"""A small tool-only agent driven by the vitest suite (no model calls; those are covered by the
reference agent). Prints a JSON summary the test asserts on. VARIANT=changed alters one call's
arguments so a replay diverges and the later write is blocked."""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from shadowlap import ShadowlapInjectedFailure, ShadowlapWriteBlocked, ReplayedError, is_active, now, random, tool, uuid  # noqa: E402

executed = []


@tool(effect="read")
def search_web(query: str, limit: int = 3) -> dict:
    executed.append("search_web")
    return {"results": [f"{query} #{i}" for i in range(limit)]}


@tool(effect="pure")
def read_file(path: str) -> str:
    executed.append("read_file")
    if path == "missing.txt":
        raise FileNotFoundError(f"no such file: {path}")
    return f"contents of {path}"


@tool(effect="write", on_fork=lambda to, body: {"sent": False, "suppressed": True, "to": to})
def send_email(to: str, body: str) -> dict:
    executed.append("send_email")
    return {"sent": True, "to": to}


@tool(name="fetch_async", effect="read")
async def fetch_page(url: str) -> dict:
    executed.append("fetch_async")
    await asyncio.sleep(0.001)
    return {"url": url, "status": 200}


class RunContext:  # stands in for a framework context object: not JSON, not identity
    def __init__(self):
        self.deps = object()


@tool(effect="read", exclude=("ctx",))
def with_context(ctx: RunContext, topic: str) -> dict:
    executed.append("with_context")
    return {"topic": topic, "has_ctx": isinstance(ctx, RunContext)}


async def main() -> dict:
    out = {"active": is_active(), "started_at": now("start"), "request_id": uuid(), "rand": random()}
    try:
        out["search"] = search_web("replay", limit=2 if os.environ.get("VARIANT") == "changed" else 3)
    except ShadowlapInjectedFailure as e:  # a replay with --fail-at on this call
        out["search"] = {"failed": type(e).__name__, "message": str(e), "timeout": isinstance(e, TimeoutError)}
    out["file"] = read_file(path="notes.md")
    out["file_again"] = read_file("notes.md")
    try:
        read_file("missing.txt")
    except FileNotFoundError as e:
        out["missing"] = f"FileNotFoundError: {e}"
    except ReplayedError as e:
        out["missing"] = f"{e.name}: {e.args[0]}"
    try:
        out["page"] = await fetch_page("https://example.com/a")
    except ShadowlapInjectedFailure as e:
        out["page"] = {"failed": type(e).__name__, "status": getattr(e, "status_code", None)}
    out["ctx"] = with_context(RunContext(), topic="replay")
    try:
        out["email"] = send_email(to="team@example.com", body="hi")
    except ShadowlapWriteBlocked as e:
        out["email"] = f"blocked: {e.tool}"
    out["executed"] = executed
    return out


print(json.dumps(asyncio.run(main())))
