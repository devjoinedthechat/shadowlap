"""A Claude Agent SDK agent's tool calls, run through the stand-in for Claude Code's tool pipeline
(fake_claude_code.py) with the shadowlap fence, against whatever sidecar SHADOWLAP_URL names: the
vitest suite records, replays and forks it (packages/adapters/test/claude-agent-sdk-python.test.ts).
VARIANT=changed changes the first command, so a replay forks there. Prints a JSON summary."""

import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from shadowlap.adapters.claude_agent_sdk import with_fence

from fake_claude_code import FakeClaudeCode

ROOT = "/proj"


async def main() -> dict:
    import dataclasses

    @dataclasses.dataclass
    class AgentOptions:  # stands in for ClaudeAgentOptions, a dataclass with hooks
        cwd: str = ROOT
        hooks: object = None

    # No settings file of this machine is read: a hook in one would change what the fence does.
    options = with_fence(AgentOptions(), scratch=tempfile.mkdtemp(prefix="shadowlap-fence-"), log=lambda line: None, settings={"sources": [], "managed_file": None})
    cc = FakeClaudeCode(options.hooks, ROOT)
    cc.files[f"{ROOT}/notes.md"] = "old line\nmore\n"
    first = "echo bye > out.txt" if os.environ.get("VARIANT") == "changed" else "echo hi > out.txt"
    script = [
        ("Read", {"file_path": f"{ROOT}/notes.md"}),
        ("Bash", {"command": first}),
        ("Write", {"file_path": f"{ROOT}/report.md", "content": "draft"}),
        ("Bash", {"command": "cd sub"}),
        ("Bash", {"command": "fail 3 tests failed"}),
        ("Edit", {"file_path": f"{ROOT}/notes.md", "old_string": "old line", "new_string": "new line"}),
    ]
    results = [await cc.call(tool, inp, f"toolu_{i}") for i, (tool, inp) in enumerate(script)]
    await cc.stop()
    return {"results": results, "notes": cc.notes, "ran": cc.ran, "project": sorted(f for f in cc.files if f.startswith(ROOT))}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main())))
