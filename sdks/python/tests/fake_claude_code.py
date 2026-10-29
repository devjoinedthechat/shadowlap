"""A stand-in for Claude Code's tool pipeline, to test hooks against without the CLI: the Python twin
of packages/adapters/test/fake-claude-code.ts, which says what it follows. In short: the SDK's
documented hook contract (matchers, callbacks run at once, the query's own and those of the
settings files Claude Code loads alike, deny > defer > ask > allow, ``updatedInput`` replacing the
whole input, ``updatedToolOutput`` used when it has the tool's output shape, PostToolUseFailure only
for a call that raised, a hook's ``continue: false`` stopping the session), and what Claude Code
2.1.309 was seen to do where the documentation is silent (the rewrite of the hook that answered last
wins, input checked against the files before any hook and again after a rewrite, a deny read as
"PreToolUse:<tool> hook error: <reason>", a hook that raises counting as ``{}``, a Bash failure as
"Exit code N" then its output, a note when Bash moves the shell)."""

import asyncio
import re
from typing import Any, Callable, Optional

RANK = {"deny": 4, "defer": 3, "ask": 2, "allow": 1}

SHAPES = {
    "Bash": {"stdout": str, "stderr": str, "interrupted": bool},
    "Write": {"type": str, "filePath": str, "content": str},
    "Edit": {"filePath": str, "oldString": str, "newString": str},
    "Read": {"type": str, "file": dict},
    "WebFetch": {"bytes": int, "code": int, "result": str, "url": str},
}
INPUTS = {
    "Bash": ["command", "description", "timeout", "run_in_background"],
    "Write": ["file_path", "content"],
    "Edit": ["file_path", "old_string", "new_string", "replace_all"],
    "Read": ["file_path", "offset", "limit"],
    "WebFetch": ["url", "prompt"],
    "NotebookEdit": ["notebook_path", "new_source", "cell_id", "edit_mode"],
}
REQUIRED = {"Bash": ["command"], "Write": ["file_path", "content"], "Edit": ["file_path", "old_string", "new_string"], "Read": ["file_path"], "WebFetch": ["url", "prompt"], "NotebookEdit": ["notebook_path", "new_source"]}


def matches(matcher: Optional[str], tool: str) -> bool:
    if matcher is None or matcher in ("", "*"):
        return True
    if re.match(r"^[A-Za-z0-9_ ,|-]+$", matcher):
        return any(m.strip() == tool for m in re.split(r"[|,]", matcher))
    return re.search(matcher, tool) is not None


class ToolError(Exception):
    pass


def unquote(s: str) -> str:
    return s.replace("'\\''", "'")


class FakeClaudeCode:
    def __init__(self, hooks: dict[str, list[Any]], root: str, beside: Optional[dict[str, list[Any]]] = None):
        self.hooks = hooks
        # Hooks of the settings files Claude Code loads, which run beside the query's.
        self.beside = beside or {}
        # Why a hook stopped the session (continue: false), once one has: no tool call runs after it.
        self.stop_reason: Optional[str] = None
        self.root = root
        self.cwd = root
        self.files: dict[str, str] = {}
        self.read_state: set = set()
        self.ran: list[str] = []
        self.web: dict[str, str] = {}
        self.asked_model = 0
        self.notes: list[str] = []
        self.can_use_tool: Callable[[str, dict[str, Any]], dict[str, Any]] = lambda tool, inp: {"behavior": "deny", "message": f"Claude requested permissions to use {tool}, but you haven't granted it yet."}
        # The subagent the calls are made in, as Claude Code names it in each hook's input: (agent_id, agent_type); None for the main session.
        self.agent: Optional[tuple[str, str]] = None

    async def call(self, tool: str, given: dict[str, Any], tool_use_id: str) -> dict[str, Any]:  # noqa: C901  (held to its ceiling in lint-caps.json)
        if self.stop_reason is not None:
            return {"content": "the session was stopped: " + self.stop_reason, "is_error": True}
        checked = self._parse(tool, given)
        if isinstance(checked, str):
            return {"content": f"<tool_use_error>InputValidationError: {checked}</tool_use_error>", "is_error": True}
        invalid = self._validate(tool, checked)
        if invalid:
            return {"content": f"<tool_use_error>{invalid}</tool_use_error>", "is_error": True}
        base = {"session_id": "s", "transcript_path": "/t", "cwd": self.cwd, "permission_mode": "default", "tool_name": tool, "tool_use_id": tool_use_id, **({"agent_id": self.agent[0], "agent_type": self.agent[1]} if self.agent else {})}
        decision, reason, updated = None, "", None
        pre = await self._run("PreToolUse", tool, {**base, "hook_event_name": "PreToolUse", "tool_input": checked}, tool_use_id)
        self._stopped(pre)
        for out in pre:
            h = out.get("hookSpecificOutput") or {}
            d = h.get("permissionDecision")
            if d and RANK.get(d, 0) > RANK.get(decision or "", 0):
                decision, reason = d, h.get("permissionDecisionReason", "")
            if h.get("updatedInput") is not None:
                updated = h["updatedInput"]
        if decision == "deny":
            return {"content": f"PreToolUse:{tool} hook error: {reason}", "is_error": True}
        if decision == "defer":
            return {"content": "deferred: " + reason, "is_error": True}
        used = checked
        if updated is not None:
            again = self._parse(tool, updated)
            if isinstance(again, str):
                return {"content": f"PreToolUse hook for {tool} returned updatedInput that failed schema validation: {again}", "is_error": True}
            refused = self._validate(tool, again)
            if refused:
                return {"content": f"PreToolUse hook for {tool} returned updatedInput that the tool refused: {refused}", "is_error": True}
            used = again
        if decision != "allow" and self._needs_permission(tool, used):
            asked = self.can_use_tool(tool, used)
            if asked["behavior"] == "deny":
                return {"content": asked["message"], "is_error": True}
        try:
            output = self._execute(tool, used)
        except ToolError as err:
            self._stopped(await self._run("PostToolUseFailure", tool, {**base, "cwd": self.cwd, "hook_event_name": "PostToolUseFailure", "tool_input": used, "error": str(err), "is_interrupt": False}, tool_use_id))
            return {"content": str(err), "is_error": True}
        post = await self._run("PostToolUse", tool, {**base, "cwd": self.cwd, "hook_event_name": "PostToolUse", "tool_input": used, "tool_response": output}, tool_use_id)
        for out in post:
            h = out.get("hookSpecificOutput") or {}
            if "updatedToolOutput" in h and fits(tool, h["updatedToolOutput"]):
                output = h["updatedToolOutput"]
        self._stopped(post)
        return {"content": render(tool, output), "is_error": False}

    def _stopped(self, outs: list[dict[str, Any]]) -> None:
        """A hook that answered continue: false (continue_ in the Python SDK) stops the session."""
        stop = next((o for o in outs if o.get("continue_") is False or o.get("continue") is False), None)
        if stop is not None and self.stop_reason is None:
            self.stop_reason = stop.get("stopReason") or "stopped by a hook"

    async def stop(self) -> None:
        await self._run("Stop", "", {"session_id": "s", "cwd": self.cwd, "hook_event_name": "Stop", "stop_hook_active": False}, None)

    async def _run(self, event: str, tool: str, data: dict[str, Any], tool_use_id: Optional[str]) -> list[dict[str, Any]]:
        callbacks = [cb for m in [*self.hooks.get(event, []), *self.beside.get(event, [])] if event == "Stop" or matches(m.matcher, tool) for cb in m.hooks]
        # In the order they answered: a rewrite of the input or the output is the last one's.
        answered: list[dict[str, Any]] = []

        async def one(cb: Any) -> None:
            try:
                answered.append(await cb(data, tool_use_id, {"signal": None}))
            except Exception:
                answered.append({})  # a callback that raises counts as {}: the call goes on

        await asyncio.gather(*(one(cb) for cb in callbacks))
        return answered

    def _parse(self, tool: str, given: dict[str, Any]) -> Any:
        known = INPUTS.get(tool)
        if known is None:
            return dict(given)
        missing = [k for k in REQUIRED.get(tool, []) if given.get(k) is None]
        if missing:
            return ", ".join(missing) + " is missing"
        return {k: v for k, v in given.items() if k in known}

    def _path(self, p: Any) -> str:
        s = str(p)
        return s if s.startswith("/") else f"{self.cwd}/{s}"

    def _validate(self, tool: str, inp: dict[str, Any]) -> Optional[str]:
        if tool == "Read" and self._path(inp["file_path"]) not in self.files:
            return "File does not exist."
        if tool == "Write":
            f = self._path(inp["file_path"])
            if f in self.files and f not in self.read_state:
                return "File has not been read yet. Read it first before writing to it."
        if tool == "Edit":
            f = self._path(inp["file_path"])
            now = self.files.get(f)
            if now is None:
                return None if inp["old_string"] == "" else "File does not exist."
            if inp["old_string"] == "":
                return "Cannot create new file - file already exists."
            if f not in self.read_state:
                return "File has not been read yet. Read it first before writing to it."
            if str(inp["old_string"]) not in now:
                return "String to replace not found in file.\nString: " + str(inp["old_string"])
        if tool == "NotebookEdit" and self._path(inp["notebook_path"]) not in self.read_state:
            return "File has not been read yet. Read it first before writing to it."
        return None

    def _needs_permission(self, tool: str, inp: dict[str, Any]) -> bool:
        return tool in ("Write", "Edit", "Read") and not self._path(inp["file_path"]).startswith(self.root)

    def _execute(self, tool: str, inp: dict[str, Any]) -> Any:
        if tool == "Bash":
            return self._bash(str(inp["command"]))
        if tool == "Write":
            f = self._path(inp["file_path"])
            before = self.files.get(f)
            self.files[f] = str(inp["content"])
            self.read_state.add(f)
            return {"type": "create" if before is None else "update", "filePath": str(inp["file_path"]), "content": str(inp["content"]), "structuredPatch": [], "originalFile": before}
        if tool == "Edit":
            f = self._path(inp["file_path"])
            before = self.files.get(f, "")
            self.files[f] = str(inp["new_string"]) if inp["old_string"] == "" else before.replace(str(inp["old_string"]), str(inp["new_string"]), 1)
            self.read_state.add(f)
            return {"filePath": str(inp["file_path"]), "oldString": str(inp["old_string"]), "newString": str(inp["new_string"]), "originalFile": before, "structuredPatch": [], "userModified": False, "replaceAll": False}
        if tool == "Read":
            f = self._path(inp["file_path"])
            content = self.files[f]
            self.read_state.add(f)
            return {"type": "text", "file": {"filePath": str(inp["file_path"]), "content": content, "numLines": content.count("\n") + 1, "startLine": 1, "totalLines": content.count("\n") + 1}}
        if tool == "WebFetch":
            page = self.web.get(str(inp["url"]))
            if page is None:
                raise ToolError("Request failed with status code 404")
            self.asked_model += 1
            return {"bytes": len(page), "code": 200, "codeText": "OK", "result": "summary of " + page, "durationMs": 1, "url": str(inp["url"])}
        if tool == "NotebookEdit":
            self.files[self._path(inp["notebook_path"])] = str(inp["new_source"])
            return {"new_source": str(inp["new_source"]), "cell_type": "code", "language": "python", "edit_mode": "replace", "notebook_path": str(inp["notebook_path"]), "original_file": "", "updated_file": ""}
        return {"content": [{"type": "text", "text": tool + " ran"}]}

    def _bash(self, command: str) -> dict[str, Any]:
        self.ran.append(command)
        ok = {"stdout": "", "stderr": "", "interrupted": False, "isImage": False}
        if command == "true":
            return ok
        m = re.match(r"^builtin cd -- '((?:[^']|'\\'')*)' 2>/dev/null \|\| true$", command) or re.match(r"^cd (\S+)$", command)
        if m:
            to = unquote(m.group(1))
            nxt = to if to.startswith("/") else f"{self.cwd}/{to}"
            if nxt != self.cwd:
                self.notes.append(f"# Environment update\n - Primary working directory: {nxt} (was {self.cwd})")
            self.cwd = nxt
            return ok
        m = re.match(r"^printf '%s' '((?:[^']|'\\'')*)'; exit (\d+)$", command, re.S)
        if m:
            raise ToolError(f"Exit code {m.group(2)}\n{unquote(m.group(1))}".strip())
        m = re.match(r"^cat -- '((?:[^']|'\\'')*)'; exit (\d+)$", command)
        if m:
            with open(unquote(m.group(1)), encoding="utf-8") as f:
                raise ToolError(f"Exit code {m.group(2)}\n{f.read()}".strip())
        m = re.match(r"^echo (.*) > (\S+)$", command)
        if m:
            self.files[self._path(m.group(2))] = m.group(1) + "\n"
            return ok
        m = re.match(r"^fail (\d+) (.*)$", command)
        if m:
            raise ToolError(f"Exit code {m.group(1)}\n{m.group(2)}")
        return {**ok, "stdout": "ran: " + command}


def fits(tool: str, output: Any) -> bool:
    shape = SHAPES.get(tool)
    if shape is None:
        return True
    return isinstance(output, dict) and all(isinstance(output.get(k), t) for k, t in shape.items())


def render(tool: str, o: Any) -> str:
    if tool == "Bash":
        return "\n".join(x for x in (str(o["stdout"]).rstrip(), str(o["stderr"]).strip()) if x) or "(Bash completed with no output)"
    if tool == "Write":
        return ("File created successfully at: %s" if o["type"] == "create" else "The file %s has been updated successfully.") % o["filePath"]
    if tool == "Edit":
        return "The file %s has been updated successfully." % o["filePath"]
    if tool == "Read":
        return str(o["file"]["content"])
    if tool == "WebFetch":
        return str(o["result"])
    return repr(o)
