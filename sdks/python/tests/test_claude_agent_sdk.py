"""The Claude Agent SDK fence in Python, against a stand-in for Claude Code's tool pipeline
(fake_claude_code.py) and an in-memory stand-in for the sidecar's call API. The vitest suite also
runs the same fence against a real sidecar (packages/adapters/test/claude-agent-sdk-python.test.ts)."""

import asyncio
import dataclasses
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from typing import Any, Callable, ClassVar, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import shadowlap
from shadowlap.adapters._claude_hooks import matcher_picks
from shadowlap.adapters.claude_agent_sdk import BUILT_IN_EFFECTS, _Matcher, fence_hooks, with_effects, with_fence

from fake_claude_code import FakeClaudeCode, matches

try:
    import trio
except ImportError:
    trio = None

ROOT = "/proj"


class Sidecar:
    """The sidecar's call API as the fence uses it: a recording, then a replay of it that serves
    calls matched by name and arguments, and after the first that doesn't match, refuses (or stubs)
    writes and runs reads live."""

    def __init__(self, recording: Optional[list[dict[str, Any]]] = None, writes: str = "block", gone: bool = False):
        self.recording = recording
        self.writes = writes
        self.gone = gone
        self.calls: list[dict[str, Any]] = []
        self.hellos: list[dict[str, Any]] = []
        self.consumed: set = set()
        self.diverged = False

    def __call__(self, cfg: Any, path: str, body: dict[str, Any]) -> dict[str, Any]:
        if self.gone:
            raise RuntimeError("shadowlap sidecar /v1/calls/resolve failed: connection refused")
        json.dumps(body, allow_nan=False)
        if path.endswith("/v1/hello"):
            self.hellos.append(body)
            return {"ok": True}
        if path.endswith("/resolve"):
            call_no = len(self.calls) + 1
            entry: dict[str, Any] = {"name": body["name"], "effect": body["effect"], "args": body["args"], "end": None}
            self.calls.append(entry)
            if self.recording is not None and not self.diverged:
                for i, rec in enumerate(self.recording):
                    if i not in self.consumed and rec["name"] == body["name"] and rec["args"] == body["args"]:
                        self.consumed.add(i)
                        entry.update(origin="replayed", end=rec["end"])
                        end = rec["end"]
                        return {"origin": "replayed", "callNo": call_no, **({"outcome": "ok", "result": end["result"]} if end["outcome"] == "ok" else {"outcome": "error", "error": end["error"]})}
                self.diverged = True
            if self.recording is not None and body["effect"] == "write" and self.writes != "allow":
                if self.writes == "stub":
                    entry["origin"] = "stubbed"
                    return {"origin": "stubbed", "callNo": call_no}
                entry["origin"] = "blocked"
                return {"origin": "blocked", "callNo": call_no, "outcome": "error", "error": {"name": "ShadowlapWriteBlocked", "message": f"write tool {body['name']} blocked after divergence"}}
            entry["origin"] = "live"
            return {"origin": "live", "callNo": call_no}
        m = re.match(r".*/v1/calls/(\d+)/complete$", path)
        self.calls[int(m.group(1)) - 1]["end"] = body
        return {"ok": True}


SCRIPT = [
    ("Read", {"file_path": f"{ROOT}/notes.md"}),
    ("Bash", {"command": "echo hi > out.txt", "description": "write a file"}),
    ("Write", {"file_path": f"{ROOT}/report.md", "content": "draft"}),
    ("Bash", {"command": "cd sub"}),
    ("Bash", {"command": "fail 3 tests failed"}),
    ("WebFetch", {"url": "https://example.com/docs", "prompt": "summarize"}),
    ("Edit", {"file_path": f"{ROOT}/notes.md", "old_string": "old line", "new_string": "new line"}),
]


def session(hooks: dict[str, list[Any]], beside: Optional[dict[str, list[Any]]] = None) -> FakeClaudeCode:
    """A Claude Code session on the project as it is before the agent runs; ``beside``, the hooks of the settings files it loads."""
    cc = FakeClaudeCode(hooks, ROOT, beside)
    cc.files[f"{ROOT}/notes.md"] = "old line\nmore\n"
    cc.web["https://example.com/docs"] = "the docs page"
    return cc


def fenced(**options: Any) -> dict[str, list[Any]]:
    """The fence's hooks. No settings file of this machine is read: only those a test names."""
    options.setdefault("settings", {"sources": [], "managed_file": None})
    options.setdefault("log", lambda line: None)
    return fence_hooks(scratch=tempfile.mkdtemp(prefix="shadowlap-fence-test-"), **options)


def marking(delay: float) -> Any:
    """A PreToolUse hook of the agent's own that marks every Bash command it is given, answering ``delay`` seconds late."""

    async def hook(input_data: dict[str, Any], tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
        await asyncio.sleep(delay)
        given = input_data["tool_input"]
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {**given, "command": given["command"] + " # checked"}}}

    return _Matcher(matcher="Bash", hooks=[hook])


async def agent(cc: FakeClaudeCode, script: list[Any] = SCRIPT) -> dict[str, Any]:
    results = [await cc.call(tool, dict(inp), f"toolu_{i}") for i, (tool, inp) in enumerate(script)]
    await cc.stop()
    return {"results": results, "notes": list(cc.notes)}


class Fence(unittest.TestCase):
    def setUp(self) -> None:
        self._post = shadowlap._post
        os.environ["SHADOWLAP_URL"] = "http://sidecar.test"

    def tearDown(self) -> None:
        shadowlap._post = self._post
        os.environ.pop("SHADOWLAP_URL", None)

    def record(self) -> tuple:
        sidecar = Sidecar()
        shadowlap._post = sidecar
        cc = session(fenced())
        out = asyncio.run(agent(cc))
        return sidecar, cc, out

    def test_records_each_built_in_tool_with_its_effect_and_a_failure_as_a_failure(self) -> None:
        sidecar, cc, out = self.record()
        self.assertEqual(cc.ran, ["echo hi > out.txt", "cd sub", "fail 3 tests failed"])
        self.assertEqual([(c["name"], c["effect"], c["end"]["outcome"]) for c in sidecar.calls], [("Read", "read", "ok"), ("Bash", "write", "ok"), ("Write", "write", "ok"), ("Bash", "write", "ok"), ("Bash", "write", "error"), ("WebFetch", "read", "ok"), ("Edit", "write", "ok")])
        self.assertEqual(sidecar.calls[1]["args"], {"command": "echo hi > out.txt", "description": "write a file"})
        self.assertEqual(sidecar.calls[3]["end"]["result"]["shadowlapCwd"], f"{ROOT}/sub")
        self.assertEqual(sidecar.calls[4]["end"]["error"], {"name": "ToolError", "message": "Exit code 3\ntests failed", "code": "3"})
        self.assertEqual(out["results"][4], {"content": "Exit code 3\ntests failed", "is_error": True})

    def test_replays_without_running_a_write_again(self) -> None:
        recorded, _, first = self.record()
        sidecar = Sidecar(recording=recorded.calls)
        shadowlap._post = sidecar
        cc = session(fenced())
        cc.files[f"{ROOT}/notes.md"] = "old line\nmore\nand a line added since\n"
        again = asyncio.run(agent(cc))
        self.assertEqual(again, first)
        self.assertFalse(sidecar.diverged)
        self.assertEqual(len(cc.ran), 3)
        self.assertTrue(all(c == "true" or c.startswith("builtin cd -- ") or c.startswith("printf '%s'") for c in cc.ran), cc.ran)
        # The shell's own cd: a cd function the user's shell defines, which could run anything, never runs.
        back = next(c for c in cc.ran if "cd -- " in c)
        if os.name != "nt":
            import subprocess

            out = subprocess.run(["bash", "-c", 'cd() { echo "the cd function ran"; }; ' + back], capture_output=True, text=True, timeout=30)
            self.assertEqual(out.stdout, "")
        self.assertNotIn(f"{ROOT}/out.txt", cc.files)
        self.assertNotIn(f"{ROOT}/report.md", cc.files)
        self.assertEqual(cc.files[f"{ROOT}/notes.md"], "old line\nmore\nand a line added since\n")
        self.assertEqual(cc.asked_model, 1)  # reads run as they are

    def fork(self, writes: str) -> tuple:
        recorded, _, first = self.record()
        sidecar = Sidecar(recording=recorded.calls, writes=writes)
        shadowlap._post = sidecar
        cc = session(fenced())
        script = [(t, {**i, "command": "echo bye > out.txt"}) if i.get("command") == "echo hi > out.txt" else (t, i) for t, i in SCRIPT]
        return sidecar, cc, asyncio.run(agent(cc, script)), first

    def test_refuses_writes_after_a_fork_and_runs_reads_live(self) -> None:
        sidecar, cc, out, first = self.fork("block")
        self.assertTrue(sidecar.diverged)
        self.assertEqual(cc.ran, [])
        self.assertRegex(out["results"][1]["content"], r"^PreToolUse:Bash hook error: write tool Bash blocked")
        self.assertEqual(out["results"][5], first["results"][5])
        self.assertEqual([c["origin"] for c in sidecar.calls], ["replayed", "blocked", "blocked", "blocked", "blocked", "live", "blocked"])
        self.assertEqual(sidecar.calls[5]["end"]["outcome"], "ok")

    def test_stubs_writes_after_a_fork(self) -> None:
        sidecar, cc, out, _ = self.fork("stub")
        self.assertEqual(out["results"][1], {"content": "(Bash completed with no output)", "is_error": False})
        self.assertEqual(out["results"][2], {"content": f"File created successfully at: {ROOT}/report.md", "is_error": False})
        self.assertNotIn(f"{ROOT}/out.txt", cc.files)
        self.assertNotIn(f"{ROOT}/report.md", cc.files)
        stubbed = [c for c in sidecar.calls if c["origin"] == "stubbed"]
        self.assertTrue(all(c["end"]["outcome"] == "ok" for c in stubbed))
        self.assertEqual(next(c for c in stubbed if c["name"] == "Write")["end"]["result"]["filePath"], f"{ROOT}/report.md")

    def test_refuses_a_write_it_cannot_record(self) -> None:
        shadowlap._post = Sidecar(gone=True)
        cc = session(fenced())
        write = asyncio.run(cc.call("Bash", {"command": "echo hi > out.txt"}, "toolu_a"))
        read = asyncio.run(cc.call("Read", {"file_path": f"{ROOT}/notes.md"}, "toolu_b"))
        self.assertRegex(write["content"], r"^PreToolUse:Bash hook error: shadowlap: Bash was not run: it is a write, and it could not be recorded")
        self.assertEqual(cc.ran, [])
        self.assertEqual(read, {"content": "old line\nmore\n", "is_error": False})

    def test_changes_nothing_outside_shadowlap(self) -> None:
        os.environ.pop("SHADOWLAP_URL", None)
        cc = session(fenced())
        asyncio.run(agent(cc))
        self.assertEqual(cc.ran, ["echo hi > out.txt", "cd sub", "fail 3 tests failed"])

    def test_ends_a_call_a_permission_refused(self) -> None:
        sidecar = Sidecar()
        shadowlap._post = sidecar
        cc = session(fenced())
        refused = asyncio.run(cc.call("Write", {"file_path": "/etc/hosts", "content": "x"}, "toolu_r"))
        asyncio.run(cc.stop())
        self.assertTrue(refused["is_error"])
        self.assertEqual(sidecar.calls[0]["end"]["error"]["name"], "NotRun")

    def test_forks_safely_where_claude_code_checks_a_file_a_fenced_write_never_made(self) -> None:
        script = [("Write", {"file_path": f"{ROOT}/new.md", "content": "alpha"}), ("Edit", {"file_path": f"{ROOT}/new.md", "old_string": "alpha", "new_string": "beta"})]
        recorded = Sidecar()
        shadowlap._post = recorded
        asyncio.run(agent(session(fenced()), script))
        shadowlap._post = Sidecar(recording=recorded.calls)
        cc = session(fenced())
        out = asyncio.run(agent(cc, script))
        self.assertEqual(out["results"][1], {"content": "<tool_use_error>File does not exist.</tool_use_error>", "is_error": True})
        self.assertNotIn(f"{ROOT}/new.md", cc.files)

    def test_a_long_bash_failure_is_reproduced_from_a_file(self) -> None:
        long = "x" * 20000
        recorded = Sidecar()
        shadowlap._post = recorded
        asyncio.run(agent(session(fenced()), [("Bash", {"command": "fail 2 " + long})]))
        shadowlap._post = Sidecar(recording=recorded.calls)
        cc = session(fenced())
        out = asyncio.run(agent(cc, [("Bash", {"command": "fail 2 " + long})]))
        self.assertEqual(out["results"][0], {"content": "Exit code 2\n" + long, "is_error": True})
        self.assertTrue(cc.ran[0].startswith("cat -- "))

    def test_matches_only_the_tools_it_records(self) -> None:
        matcher = fence_hooks()["PreToolUse"][0].matcher
        self.assertTrue(all(matches(matcher, t) for t in BUILT_IN_EFFECTS))
        self.assertFalse(any(matches(matcher, t) for t in ("BashOutput", "TodoWrite", "Agent", "mcp__orders__lookup_order")))

    def test_with_fence_runs_the_query_s_pre_and_post_tool_use_hooks_inside_and_keeps_the_rest(self) -> None:
        @dataclasses.dataclass
        class Options:
            cwd: str = ROOT
            hooks: Optional[dict[str, list[Any]]] = None

        mine, stop = _Matcher(matcher="Bash", hooks=[]), object()
        out = with_fence(Options(hooks={"PreToolUse": [mine], "PostToolUse": [_Matcher(matcher="Bash", hooks=[], timeout=900)], "Stop": [stop]}))
        self.assertEqual(out.cwd, ROOT)
        # One PreToolUse hook, the fence's, which picks every tool: the query's may pick any.
        self.assertEqual(len(out.hooks["PreToolUse"]), 1)
        self.assertIsNot(out.hooks["PreToolUse"][0], mine)
        self.assertIsNone(out.hooks["PreToolUse"][0].matcher)
        # It waits as long as the longest of theirs.
        self.assertEqual(out.hooks["PostToolUse"][0].timeout, 900)
        self.assertIs(out.hooks["Stop"][0], stop)
        self.assertEqual(sorted(out.hooks), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop", "SubagentStop", "UserPromptSubmit"])

    def test_says_the_claude_code_cli_runs_with_no_guard_once(self) -> None:
        sidecar = Sidecar()
        shadowlap._post = sidecar
        hooks = fenced()
        asyncio.run(hooks["UserPromptSubmit"][0].hooks[0]({"hook_event_name": "UserPromptSubmit", "prompt": "go", "cwd": ROOT}, None, {}))
        asyncio.run(agent(session(hooks), [("Bash", {"command": "true"})]))
        self.assertEqual(sidecar.hellos, [{"runtimeVersion": "", "ppid": os.getppid(), "runtime": "claude-code", "pid": os.getpid(), "guard": "off", "capture": False}])
        # Outside Shadowlap it says nothing.
        os.environ.pop("SHADOWLAP_URL", None)
        quiet = Sidecar()
        shadowlap._post = quiet
        asyncio.run(fenced()["UserPromptSubmit"][0].hooks[0]({"hook_event_name": "UserPromptSubmit", "prompt": "go"}, None, {}))
        self.assertEqual(quiet.hellos, [])

    def test_says_what_the_query_leaves_the_cli_to_reach(self) -> None:
        home = tempfile.mkdtemp(prefix="shadowlap-fence-home-")
        self.addCleanup(shutil.rmtree, home, True)
        env = {"HOME": home, "CLAUDE_CONFIG_DIR": os.path.join(home, ".claude"), "ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": "", "ANTHROPIC_BASE_URL": os.environ.get("ANTHROPIC_BASE_URL", "")}

        @dataclasses.dataclass
        class Options:
            cwd: str = home
            hooks: Optional[dict[str, list[Any]]] = None
            setting_sources: Optional[list[str]] = dataclasses.field(default_factory=list)
            env: dict[str, str] = dataclasses.field(default_factory=lambda: dict(env))
            disallowed_tools: list[str] = dataclasses.field(default_factory=list)
            mcp_servers: dict[str, Any] = dataclasses.field(default_factory=dict)

        def hello(options: Any) -> dict[str, Any]:
            sidecar = Sidecar()
            shadowlap._post = sidecar
            fenced_options = with_fence(options, settings={"managed_file": None})
            asyncio.run(fenced_options.hooks["UserPromptSubmit"][0].hooks[0]({"hook_event_name": "UserPromptSubmit", "prompt": "go", "cwd": home}, None, {}))
            return sidecar.hellos[0]

        # WebFetch, and the claude.ai connectors with no API key.
        self.assertEqual(hello(Options())["reach"], ["WebFetch, which fetches each page itself", "claude.ai connectors, which a claude.ai login brings"])
        # Nothing left: WebFetch disallowed, an API key, its traffic off (with_fence turned it off).
        closed = Options(disallowed_tools=["WebFetch"], env={**env, "ANTHROPIC_API_KEY": "sk-test"})
        self.assertEqual(hello(closed)["reach"], [])
        self.assertEqual(with_fence(closed).env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1")
        # An MCP server over the network the query connects.
        self.assertEqual(hello(Options(disallowed_tools=["WebFetch"], env={**env, "ANTHROPIC_API_KEY": "sk-test"}, mcp_servers={"docs": {"type": "http", "url": "https://docs.example/mcp"}}))["reach"], ['the MCP server "docs" (http)'])

    def test_turns_the_cli_s_nonessential_traffic_off_under_shadowlap_unless_the_env_sets_it(self) -> None:
        @dataclasses.dataclass
        class Options:
            cwd: str = ROOT
            hooks: Optional[dict[str, list[Any]]] = None
            env: dict[str, str] = dataclasses.field(default_factory=dict)

        self.assertEqual(with_fence(Options(env={"A": "1"})).env, {"A": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"})
        self.assertEqual(with_fence(Options(env={"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": ""})).env, {"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": ""})
        os.environ.pop("SHADOWLAP_URL", None)
        self.assertEqual(with_fence(Options(env={"A": "1"})).env, {"A": "1"})

    def test_picks_the_tools_claude_code_picks(self) -> None:
        cases = [(None, "Bash"), ("", "Bash"), ("*", "Write"), ("Bash", "Bash"), ("Bash", "BashOutput"), ("Edit|Write", "Write"), ("Edit, Write", "Edit"), ("Edit.*", "NotebookEdit"), ("^Edit$", "NotebookEdit"), ("mcp__kb__.*", "mcp__kb__search")]
        for matcher, tool in cases:
            self.assertEqual(matcher_picks(matcher, tool), matches(matcher, tool), (matcher, tool))
        self.assertFalse(matcher_picks("(", "Bash"))
        self.assertTrue(matcher_picks("(", "Bash", "all"))


class BesideOtherHooks(unittest.TestCase):
    """Claude Code takes the rewrite of whichever hook answers last: a hook beside the fence could put
    the recorded command back. The query's own run inside the fence; a settings file's is refused."""

    BASH: ClassVar[list[tuple[str, dict[str, str]]]] = [("Bash", {"command": "echo hi > out.txt"})]

    def setUp(self) -> None:
        self._post = shadowlap._post
        os.environ["SHADOWLAP_URL"] = "http://sidecar.test"

    def tearDown(self) -> None:
        shadowlap._post = self._post
        os.environ.pop("SHADOWLAP_URL", None)

    def recorded(self, hooks: dict[str, list[Any]], script: Optional[list[Any]] = None) -> tuple:
        sidecar = Sidecar()
        shadowlap._post = sidecar
        cc = session(hooks)
        asyncio.run(agent(cc, script or self.BASH))
        return sidecar, cc

    def test_runs_a_pre_tool_use_hook_of_the_query_first_so_a_replay_never_runs_the_write(self) -> None:
        for delay in (0, 0.15):
            with self.subTest(delay=delay):
                recorded, cc = self.recorded(fenced(hooks={"PreToolUse": [marking(delay)]}))
                # While recording the call runs as the hook rewrote it, and is recorded so.
                self.assertEqual(cc.ran, ["echo hi > out.txt # checked"])
                self.assertEqual(recorded.calls[0]["args"], {"command": "echo hi > out.txt # checked"})
                sidecar = Sidecar(recording=recorded.calls)
                shadowlap._post = sidecar
                again = session(fenced(hooks={"PreToolUse": [marking(delay)]}))
                out = asyncio.run(agent(again, self.BASH))
                self.assertEqual(again.ran, ["true"])
                self.assertFalse(sidecar.diverged)
                self.assertEqual(out["results"][0], {"content": "ran: echo hi > out.txt # checked", "is_error": False})

    def test_keeps_a_refusal_of_the_query_s_own(self) -> None:
        async def refusing(input_data: dict[str, Any], tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "no shell here"}}

        recorded, cc = self.recorded(fenced(hooks={"PreToolUse": [_Matcher(matcher="Bash", hooks=[refusing])]}))
        self.assertEqual(cc.ran, [])
        self.assertEqual(recorded.calls, [])

    def test_a_hook_that_does_not_answer_in_time_blocks_the_call(self) -> None:
        async def slow(input_data: dict[str, Any], tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
            await asyncio.sleep(5)
            return {}

        shadowlap._post = Sidecar()
        cc = session(fenced(hooks={"PreToolUse": [_Matcher(matcher="Bash", hooks=[slow], timeout=0.05)]}))
        out = asyncio.run(agent(cc, self.BASH))
        self.assertEqual(cc.ran, [])
        self.assertEqual(out["results"][0]["content"], "PreToolUse:Bash hook error: a PreToolUse hook did not answer within its timeout of 0.05 seconds")

    def test_runs_a_post_tool_use_hook_of_the_query_on_the_recorded_output(self) -> None:
        async def noting(input_data: dict[str, Any], tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
            await asyncio.sleep(0.15)
            response = input_data["tool_response"]
            return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "updatedToolOutput": {**response, "stdout": response["stdout"] + " (noted)"}}}

        listing = [("Bash", {"command": "ls"})]
        recorded, _ = self.recorded(fenced(hooks={"PostToolUse": [_Matcher(matcher="Bash", hooks=[noting])]}), listing)
        shadowlap._post = Sidecar(recording=recorded.calls)
        cc = session(fenced(hooks={"PostToolUse": [_Matcher(matcher="Bash", hooks=[noting])]}))
        out = asyncio.run(agent(cc, listing))
        self.assertEqual(cc.ran, ["true"])
        self.assertEqual(out["results"][0], {"content": "ran: ls (noted)", "is_error": False})

    def test_refuses_a_recorded_write_a_settings_file_s_hook_could_rewrite_and_names_the_file(self) -> None:
        recorded, _ = self.recorded(fenced())
        project = tempfile.mkdtemp(prefix="shadowlap-settings-")
        os.makedirs(os.path.join(project, ".claude"))
        settings_file = os.path.join(project, ".claude", "settings.json")
        with open(settings_file, "w", encoding="utf-8") as f:
            json.dump({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "./mark.sh"}]}]}}, f)
        shadowlap._post = Sidecar(recording=recorded.calls)
        said: list[str] = []
        # Claude Code runs the file's hook beside the fence, and its rewrite answers last.
        cc = session(fenced(settings={"sources": ["project"], "cwd": project, "managed_file": None}, log=said.append), beside={"PreToolUse": [marking(0.15)]})
        out = asyncio.run(agent(cc, self.BASH))
        self.assertEqual(cc.ran, [])
        self.assertTrue(out["results"][0]["is_error"])
        self.assertIn(f'shadowlap: Bash was not run again: a PreToolUse hook in {settings_file} (matcher "Bash") runs beside Shadowlap\'s', out["results"][0]["content"])
        self.assertIn(settings_file, "\n".join(said))

    BASH_HOOK = "hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./mark.sh\n"

    def project(self, files: dict[str, str]) -> str:
        folder = tempfile.mkdtemp(prefix="shadowlap-frontmatter-")
        self.addCleanup(shutil.rmtree, folder, True)
        for path, text in files.items():
            os.makedirs(os.path.dirname(os.path.join(folder, path)), exist_ok=True)
            with open(os.path.join(folder, path), "w", encoding="utf-8") as f:
                f.write(text)
        return folder

    def test_refuses_a_recorded_write_a_skill_s_frontmatter_hook_could_rewrite(self) -> None:
        recorded, _ = self.recorded(fenced())
        folder = self.project({".claude/skills/guard/SKILL.md": f"---\nname: guard\ndescription: d\n{self.BASH_HOOK}---\n"})
        shadowlap._post = Sidecar(recording=recorded.calls)
        cc = session(fenced(settings={"sources": ["project"], "cwd": folder, "managed_file": None, "env": {"HOME": folder}}), beside={"PreToolUse": [marking(0.15)]})
        out = asyncio.run(agent(cc, self.BASH))
        self.assertEqual(cc.ran, [])
        self.assertIn(f'a PreToolUse hook in {os.path.join(folder, ".claude", "skills", "guard", "SKILL.md")} (matcher "Bash") runs beside Shadowlap\'s', out["results"][0]["content"])

    def test_refuses_a_recorded_write_a_hook_in_the_repository_root_s_local_settings_could_rewrite(self) -> None:
        # Claude Code reads that file at the root from a subfolder, and the main checkout's from a linked worktree.
        recorded, _ = self.recorded(fenced())
        hook = json.dumps({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "./mark.sh"}]}]}})
        folder = self.project({".git/HEAD": "ref: refs/heads/main\n", "sub/.keep": "", ".claude/settings.local.json": hook})
        shadowlap._post = Sidecar(recording=recorded.calls)
        cc = session(fenced(settings={"sources": ["local"], "cwd": os.path.join(folder, "sub"), "managed_file": None, "env": {"HOME": folder}}), beside={"PreToolUse": [marking(0.15)]})
        out = asyncio.run(agent(cc, self.BASH))
        self.assertEqual(cc.ran, [])
        self.assertIn(f'a PreToolUse hook in {os.path.join(folder, ".claude", "settings.local.json")} (matcher "Bash") runs beside Shadowlap\'s', out["results"][0]["content"])

    def test_refuses_a_recorded_write_a_subagent_s_own_hook_could_rewrite_in_its_calls_alone(self) -> None:
        recorded, _ = self.recorded(fenced())
        folder = self.project({".claude/agents/review.md": f"---\nname: reviewer\ndescription: d\n{self.BASH_HOOK}---\nReview.\n"})
        places = {"sources": ["project"], "cwd": folder, "managed_file": None, "env": {"HOME": folder}}
        # The session's own call: the subagent's hook doesn't run for it, and the stand-in does.
        shadowlap._post = Sidecar(recording=recorded.calls)
        main = session(fenced(settings=places))
        asyncio.run(agent(main, self.BASH))
        self.assertEqual(main.ran, ["true"])
        # The same call made in the subagent: its hook runs beside the fence there, and the write is refused.
        shadowlap._post = Sidecar(recording=recorded.calls)
        sub = session(fenced(settings=places))
        sub.agent = ("agent-1", "reviewer")
        out = asyncio.run(agent(sub, self.BASH))
        self.assertEqual(sub.ran, [])
        self.assertIn(f'a PreToolUse hook in {os.path.join(folder, ".claude", "agents", "review.md")}, which runs while the subagent "reviewer" runs (matcher "Bash")', out["results"][0]["content"])

    def test_stops_the_session_when_a_hook_it_never_saw_replaced_its_stand_in(self) -> None:
        recorded, _ = self.recorded(fenced())
        shadowlap._post = Sidecar(recording=recorded.calls)
        said: list[str] = []
        # A plugin's or a managed hook: in no file the fence reads, and answering last.
        cc = session(fenced(log=said.append), beside={"PreToolUse": [marking(0.15)]})
        out = asyncio.run(agent(cc, [*self.BASH, ("Bash", {"command": "echo bye > out.txt"})]))
        # The write ran, which the fence could not stop; the model reads what it did, not the recording, and nothing runs after it.
        self.assertEqual(cc.ran, ["echo hi > out.txt # checked"])
        self.assertEqual(out["results"][0], {"content": "ran: echo hi > out.txt # checked", "is_error": False})
        self.assertRegex(cc.stop_reason or "", r'^shadowlap: another PreToolUse hook replaced the stand-in Shadowlap gave Bash, so Claude Code ran the call itself \(command: "echo hi > out.txt # checked"\)')
        self.assertEqual(out["results"][1], {"content": "the session was stopped: " + str(cc.stop_reason), "is_error": True})
        self.assertIn("another PreToolUse hook replaced the stand-in", "\n".join(said))


@dataclasses.dataclass
class SdkMcpTool:
    """As the SDK's @tool makes one."""

    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[[dict[str, Any]], Any]


class McpTools(unittest.TestCase):
    def setUp(self) -> None:
        self._post = shadowlap._post
        os.environ["SHADOWLAP_URL"] = "http://sidecar.test"
        self.ran: list[str] = []

        async def lookup(args: dict[str, Any]) -> dict[str, Any]:
            self.ran.append("lookup " + args["id"])
            return {"content": [{"type": "text", "text": "order %s: shipped" % args["id"]}]}

        async def refund(args: dict[str, Any]) -> dict[str, Any]:
            self.ran.append("refund " + args["id"])
            return {"content": [{"type": "text", "text": "refunded " + args["id"]}]}

        self.raw = [SdkMcpTool("lookup_order", "look up", {"id": str}, lookup), SdkMcpTool("issue_refund", "refund", {"id": str}, refund)]
        self.tools = with_effects("orders", self.raw, {"lookup_order": "read", "issue_refund": "write"})

    def tearDown(self) -> None:
        shadowlap._post = self._post
        os.environ.pop("SHADOWLAP_URL", None)

    def test_records_under_the_model_s_names_replays_and_refuses_a_write_after_a_fork(self) -> None:
        recorded = Sidecar()
        shadowlap._post = recorded
        asyncio.run(self.tools[0].handler({"id": "A-1"}))
        asyncio.run(self.tools[1].handler({"id": "A-1"}))
        self.assertEqual([(c["name"], c["effect"], c["args"]) for c in recorded.calls], [("mcp__orders__lookup_order", "read", {"id": "A-1"}), ("mcp__orders__issue_refund", "write", {"id": "A-1"})])
        shadowlap._post = Sidecar(recording=recorded.calls)
        self.assertEqual(asyncio.run(self.tools[1].handler({"id": "A-1"})), {"content": [{"type": "text", "text": "refunded A-1"}]})
        self.assertEqual(self.ran, ["lookup A-1", "refund A-1"])
        shadowlap._post = Sidecar(recording=recorded.calls)
        asyncio.run(self.tools[0].handler({"id": "B-2"}))
        refused = asyncio.run(self.tools[1].handler({"id": "B-2"}))
        self.assertTrue(refused["is_error"])
        self.assertIn("blocked", refused["content"][0]["text"])
        self.assertEqual(self.ran, ["lookup A-1", "refund A-1", "lookup B-2"])

    def test_needs_an_effect_for_every_tool(self) -> None:
        with self.assertRaisesRegex(TypeError, "missing for issue_refund"):
            with_effects("orders", self.tools, {"lookup_order": "read"})

    def test_records_a_name_with_other_characters_as_claude_code_names_it_to_the_model(self) -> None:
        # Claude Code turns every character of either name but a letter, a digit, _ and - into _, as the TypeScript adapter does.
        tools = with_effects("order desk.v2", [dataclasses.replace(t, name=n) for t, n in zip(self.raw, ["look up", "refund-€"])], {"look up": "read", "refund-€": "write"})
        recorded = Sidecar()
        shadowlap._post = recorded
        asyncio.run(tools[0].handler({"id": "A-1"}))
        asyncio.run(tools[1].handler({"id": "A-1"}))
        self.assertEqual([c["name"] for c in recorded.calls], ["mcp__order_desk_v2__look_up", "mcp__order_desk_v2__refund-_"])


@unittest.skipUnless(trio, "trio is not installed")
class UnderTrio(unittest.TestCase):
    """The SDK runs its hooks on anyio, which can run on trio: the fence asks the sidecar from trio's worker threads."""

    def setUp(self) -> None:
        self._post = shadowlap._post
        os.environ["SHADOWLAP_URL"] = "http://sidecar.test"

    def tearDown(self) -> None:
        shadowlap._post = self._post
        os.environ.pop("SHADOWLAP_URL", None)

    def test_the_hooks_record_and_replay_under_trio(self) -> None:
        hooks = fenced()
        pre, post = hooks["PreToolUse"][0].hooks[0], hooks["PostToolUse"][0].hooks[0]
        base = {"session_id": "s", "cwd": ROOT, "tool_name": "Bash", "tool_input": {"command": "echo hi > out.txt"}}
        recorded = Sidecar()
        shadowlap._post = recorded

        async def record() -> None:
            self.assertEqual(await pre({**base, "hook_event_name": "PreToolUse"}, "t1", {}), {})
            await post({**base, "hook_event_name": "PostToolUse", "tool_response": {"stdout": "", "stderr": "", "interrupted": False}}, "t1", {})

        trio.run(record)
        self.assertEqual(recorded.calls[0]["end"]["outcome"], "ok")
        shadowlap._post = Sidecar(recording=recorded.calls)

        async def replay() -> Any:
            return await pre({**base, "hook_event_name": "PreToolUse"}, "t2", {})

        out = trio.run(replay)
        self.assertEqual(out["hookSpecificOutput"]["updatedInput"]["command"], "true")

    def test_the_query_s_own_hooks_run_inside_the_fence_under_trio(self) -> None:
        async def late(input_data: dict[str, Any], tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
            await trio.sleep(0.05)
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {"command": "echo hi > out.txt # checked"}}}

        async def slow(input_data: dict[str, Any], tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
            await trio.sleep(5)
            return {}

        base = {"session_id": "s", "cwd": ROOT, "tool_name": "Bash", "tool_input": {"command": "echo hi > out.txt"}, "hook_event_name": "PreToolUse"}
        recorded = Sidecar()
        shadowlap._post = recorded
        pre = fenced(hooks={"PreToolUse": [_Matcher(matcher="Bash", hooks=[late])]})["PreToolUse"][0].hooks[0]
        self.assertEqual(trio.run(pre, base, "t1", {}), {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {"command": "echo hi > out.txt # checked"}}})
        self.assertEqual(recorded.calls[0]["args"], {"command": "echo hi > out.txt # checked"})
        timed = fenced(hooks={"PreToolUse": [_Matcher(matcher="Bash", hooks=[slow], timeout=0.05)]})["PreToolUse"][0].hooks[0]
        out = trio.run(timed, base, "t2", {})
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")


if __name__ == "__main__":
    unittest.main()
