"""What the Claude Agent SDK's fence reads of Claude Code's own files, held to the cases its TypeScript
twin is held to (claude_reach_cases.json, which packages/adapters/test/claude-reach.test.ts runs too):
the frontmatter of a skill or a subagent, the PreToolUse hooks Claude Code runs beside the fence, and
what the Claude Code CLI can reach that the network guard can't watch."""

import json
import os
import shutil
import sys
import tempfile
import unittest
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from shadowlap.adapters._claude_hooks import settings_pre_tool_use
from shadowlap.adapters._claude_reach import claude_reach
from shadowlap.adapters._frontmatter import UNREADABLE, frontmatter

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "claude_reach_cases.json"), encoding="utf-8") as f:
    CASES = json.load(f)

#: The query's options and the places, by the names the Python SDK and fence give them.
QUERY_NAMES = {"disallowedTools": "disallowed_tools", "mcpServers": "mcp_servers", "strictMcpConfig": "strict_mcp_config", "extraArgs": "extra_args"}
PLACE_NAMES = {"managedFile": "managed_file", "addDirs": "add_dirs"}


def rooted(value: Any, root: str) -> Any:
    """``$ROOT`` in every string of a case, as the folder its files are written in."""
    return json.loads(json.dumps(value).replace("$ROOT", root))


class World(unittest.TestCase):
    def world(self, files: dict[str, Any]) -> str:
        """A folder of the case's own with its files in it, objects written as JSON."""
        root = os.path.realpath(tempfile.mkdtemp(prefix="sl-claude-reach-"))
        self.addCleanup(shutil.rmtree, root, True)
        for path, content in rooted(files, root).items():
            file = os.path.join(root, path)
            os.makedirs(os.path.dirname(file), exist_ok=True)
            with open(file, "w", encoding="utf-8") as out:
                out.write(content if isinstance(content, str) else json.dumps(content))
        return root

    @staticmethod
    def places(case: dict[str, Any], root: str) -> dict[str, Any]:
        return {PLACE_NAMES.get(k, k): v for k, v in rooted({**case["places"], "env": case["env"]}, root).items()}


class Frontmatter(unittest.TestCase):
    def test_cases(self) -> None:
        for case in CASES["frontmatter"]:
            with self.subTest(case["name"]):
                keys = frontmatter(case["text"])
                if case["expect"] is None:
                    self.assertIsNone(keys)
                    continue
                assert keys is not None
                self.assertEqual({k: {"$unreadable": True} if v is UNREADABLE else v for k, v in keys.items()}, case["expect"])


class Hooks(World):
    def test_cases(self) -> None:
        for case in CASES["hooks"]:
            with self.subTest(case["name"]):
                root = self.world(case["files"])
                places = self.places(case, root)
                found = [{k: v for k, v in h.items() if v is not None} for h in settings_pre_tool_use(places, places["cwd"])]
                self.assertEqual(found, rooted(case["expect"], root))


class Reach(World):
    def test_cases(self) -> None:
        for case in CASES["reach"]:
            with self.subTest(case["name"]):
                root = self.world(case["files"])
                query = {QUERY_NAMES.get(k, k): v for k, v in rooted(case["query"], root).items()}
                self.assertEqual(claude_reach(query, self.places(case, root), rooted(case["env"], root), case["shadowlapBase"]), rooted(case["expect"], root))


if __name__ == "__main__":
    unittest.main()
