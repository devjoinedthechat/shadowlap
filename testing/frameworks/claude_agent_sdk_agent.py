"""A Claude Agent SDK agent with shadowlap's fence: query() runs Claude Code (the CLI the SDK bundles)
in PROJECT, its model calls going to whatever ANTHROPIC_BASE_URL names (the sidecar, in front of a
scripted Anthropic API), its built-in tools recorded and fenced through the hooks with_fence adds.
PROMPT is what the user asks, so a replay with another forks at the first model call. Prints a JSON
summary: the result, and the project's files as the run left them."""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

from shadowlap.adapters.claude_agent_sdk import with_fence

PROJECT = os.environ["PROJECT"]


def files() -> dict:
    out = {}
    for folder, _, names in os.walk(PROJECT):
        for name in names:
            path = os.path.join(folder, name)
            with open(path, encoding="utf-8") as f:
                out[os.path.relpath(path, PROJECT)] = f.read()
    return out


async def main() -> dict:
    env = {key: os.environ[key] for key in ("ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "HOME") if key in os.environ}
    env.update({"ANTHROPIC_API_KEY": "test-key", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1", "DISABLE_AUTOUPDATER": "1"})
    options = with_fence(ClaudeAgentOptions(cwd=PROJECT, model="claude-opus-4-8", env=env, permission_mode="bypassPermissions", setting_sources=[], max_turns=12), log=lambda line: print(line, file=sys.stderr))
    result = None
    async for message in query(prompt=os.environ.get("PROMPT", "Do the scripted thing."), options=options):
        if isinstance(message, ResultMessage):
            result = {"text": message.result, "is_error": message.is_error}
    return {"result": result, "files": files()}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main())))
