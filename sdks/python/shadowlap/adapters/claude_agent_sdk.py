"""Claude Agent SDK (``claude-agent-sdk``), and Claude Code headless underneath it.

Its built-in tools (Bash, Write, Edit, Read, WebFetch, …) run inside the Claude Code process, where
no wrapper reaches them, so they are recorded and fenced through the SDK's hooks instead::

    from claude_agent_sdk import ClaudeAgentOptions, query
    from shadowlap.adapters.claude_agent_sdk import with_fence

    async for message in query(prompt=prompt, options=with_fence(ClaudeAgentOptions(cwd=project))):
        ...

- While recording, PostToolUse records each built-in tool's input and output through the sidecar,
  and PostToolUseFailure its failure.
- On replay, up to a fork, a recorded write never runs again: PreToolUse turns its input into a
  stand-in Claude Code accepts and that changes nothing outside a temporary folder (Bash runs
  ``true``, or ``cd`` to the folder the command left; Write and Edit write a new file there), and
  PostToolUse hands the model the recorded output in its place (``updatedToolOutput``). A recorded
  Bash failure is reproduced by a command that prints its output and exits with its code. A read
  runs as it is, since reading changes nothing and keeps Claude Code's own file tracking as it was
  recorded, and the model gets the recorded output too.
- After a fork, a write goes as ``--writes`` says: ``block`` denies it with the refusal the model
  reads, ``stub`` runs the stand-in and answers with ``on_fork``'s output, and ``allow`` runs it,
  recorded.

Without Shadowlap (no SHADOWLAP_URL) every hook answers ``{}``. Claude Code checks a call's input
against the files on disk before any hook runs, so a replay forks, safely, at a call that depends on
a file an earlier, fenced write would have changed: docs/frameworks.md has this and the other limits.

Tools of an in-process MCP server (``create_sdk_mcp_server``) run in the agent's own process: wrap
them with ``with_effects``, which records and fences them like any SDK tool.
"""

from __future__ import annotations

import dataclasses
import functools
import json
import os
import re
import sys
import tempfile
import time
from collections.abc import Mapping, Sequence
from typing import Any, Callable, Optional, TypeVar

from shadowlap import (
    ReplayedError,
    ShadowlapInjectedFailure,
    ShadowlapWriteBlocked,
    _cancelled_error,
    _check_args,
    _complete_call,
    _finish,
    _injected,
    _is_cancellation,
    _recordable,
    _replay_cancellation,
    _resolve_shielded,
    _resolve_tool,
    _say_hello,
    serialize_error,
)
from shadowlap.adapters._claude_hooks import DEFAULT_TIMEOUT_S, as_output, combine, hook_runs_for, matcher_picks, run_hooks, settings_pre_tool_use
from shadowlap.adapters._claude_reach import claude_reach

__all__ = ["BUILT_IN_EFFECTS", "fence_hooks", "with_effects", "with_fence"]

#: Claude Code's built-in tools that are recorded, with their effects.
BUILT_IN_EFFECTS: Mapping[str, str] = {
    "Read": "read",
    "Glob": "read",
    "Grep": "read",
    "WebFetch": "read",
    "WebSearch": "read",
    "Write": "write",
    "Edit": "write",
    "MultiEdit": "write",
    "NotebookEdit": "write",
    "Bash": "write",
}

#: A recorded Bash call that moved the shell's working folder keeps where it left it here, beside its output.
_CWD = "shadowlapCwd"

Hook = Callable[[dict[str, Any], Optional[str], Any], Any]
Opts = TypeVar("Opts")
ToolT = TypeVar("ToolT")


@dataclasses.dataclass
class _Matcher:
    """A hook matcher, shaped as the SDK's HookMatcher, for when the SDK isn't importable here."""

    matcher: Optional[str] = None
    hooks: list[Hook] = dataclasses.field(default_factory=list)
    timeout: Optional[float] = None


def _matcher(matcher: Optional[str], hook: Hook, timeout: Optional[float] = None) -> Any:
    try:
        from claude_agent_sdk import HookMatcher
    except ImportError:
        return _Matcher(matcher=matcher, hooks=[hook], timeout=timeout)
    return HookMatcher(matcher=matcher, hooks=[hook], timeout=timeout)


def _quote(s: str) -> str:
    """A shell word the shell takes as it is."""
    return "'" + s.replace("'", "'\\''") + "'"


def _bash_failure(error: str) -> Optional[tuple[int, str]]:
    """The exit code and the rest of a recorded Bash failure, as Claude Code writes one: ``Exit code N``, then the output."""
    m = re.match(r"^Exit code (\d{1,3})(?:\n([\s\S]*))?$", error)
    if not m or not 0 < int(m.group(1)) < 256:
        return None
    return int(m.group(1)), m.group(2) or ""


class _Scratch:
    """Where stand-ins write: a new folder in the system's temporary folder, made when first needed."""

    def __init__(self, base: Optional[str]):
        self._base = base
        self._dir: Optional[str] = None
        self._n = 0

    @property
    def dir(self) -> str:
        if self._dir is None:
            if self._base:
                os.makedirs(self._base, exist_ok=True)
                self._dir = self._base
            else:
                self._dir = tempfile.mkdtemp(prefix="shadowlap-fence-")
        return self._dir

    def fresh(self, name: str) -> str:
        """A path that doesn't exist yet. Plain names: Claude Code refuses writes to files such as
        .bashrc or folders such as .git, even when a hook allows them."""
        self._n += 1
        return os.path.join(self.dir, "%d-%s.txt" % (self._n, re.sub(r"[^\w-]", "_", name)[:60] or "call"))

    def write(self, name: str, content: str) -> str:
        path = self.fresh(name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


_ACTS_ON = {"Bash": "command", "Write": "file_path", "Edit": "file_path", "MultiEdit": "file_path", "NotebookEdit": "notebook_path"}
"""The field of a tool's input that says what it acts on: Bash's command, the file a write writes."""


def _ran_other(name: str, ran: Any, stand_in: dict[str, Any]) -> bool:
    """Whether the call Claude Code ran is another than the stand-in the fence gave it: what it acts on
    differs (another hook's rewrite came last). An input Claude Code doesn't show says nothing."""
    if not isinstance(ran, dict):
        return False
    field = _ACTS_ON.get(name)
    return ran.get(field) != stand_in.get(field) if field else ran != stand_in


def _longest(matchers: Optional[Sequence[Any]]) -> Optional[float]:
    """The longest timeout of the query's matchers, when it is longer than the SDK's default: the fence's hook waits for theirs."""
    most = max([float(t) for t in (getattr(m, "timeout", None) for m in matchers or []) if isinstance(t, (int, float))] or [0.0])
    return most if most > DEFAULT_TIMEOUT_S else None


def fence_hooks(
    effects: Optional[Mapping[str, str]] = None,
    *,
    on_fork: Optional[Callable[[str, dict[str, Any], Any], Any]] = None,
    scratch: Optional[str] = None,
    log: Optional[Callable[[str], None]] = None,
    hooks: Optional[Mapping[str, Sequence[Any]]] = None,
    settings: Optional[Mapping[str, Any]] = None,
    query: Optional[Mapping[str, Any]] = None,
) -> dict[str, list[Any]]:
    """The hooks that record and fence Claude Code's built-in tools: PreToolUse, PostToolUse,
    PostToolUseFailure, and Stop and SubagentStop, which end a call Claude Code never ran (a
    permission refused it after PreToolUse). Use ``with_fence``, which runs the query's own PreToolUse
    and PostToolUse hooks inside these; merged into ``ClaudeAgentOptions.hooks`` by hand, pass those as
    ``hooks``.

    ``effects`` adds tools, or other effects for the built-ins, by the name Claude Code calls them
    (``mcp__issues__search`` for a tool of an MCP server it connects to): a read runs as it is and the
    model gets the recorded output; a write of a tool with no stand-in is refused on replay.
    ``on_fork(tool, input, stand_in_output)`` is what the model gets for a write stubbed after a fork,
    in the tool's own output shape (Claude Code ignores one that isn't); by default the stand-in's
    output, naming the original path where it names the temporary one.

    ``hooks``: the query's own PreToolUse and PostToolUse matchers, run inside the fence's. Claude Code
    takes a rewritten input or output from whichever hook answers last, so a hook beside the fence
    could put back the input of a recorded write, and the write would run again for real. Inside, they
    answer first, in the order given, and the fence has the last word. ``settings``: where Claude Code
    finds the settings it loads for the query (``sources``, ``cwd``, ``settings``, ``env``,
    ``managed_file``, ``add_dirs``, ``plugins``; with_fence passes the query's). A PreToolUse hook in
    them, or in a skill, subagent or plugin they load, runs beside the fence, where nothing can run it
    inside: a recorded write it could rewrite is refused on replay rather than handed a stand-in.
    ``query``: the query's options that decide what the Claude Code CLI connects to besides Shadowlap
    (``tools``, ``disallowed_tools``, ``mcp_servers``, ``strict_mcp_config``, ``agents``,
    ``extra_args``, ``plugins``; with_fence passes them). The fence says what they leave open when it
    tells Shadowlap the CLI runs: a run whose CLI reaches nothing the guard can't watch passes
    ``--guard block``. Without them nobody knows, and it fails."""
    table: dict[str, str] = {**BUILT_IN_EFFECTS, **(effects or {})}
    for name, effect in table.items():
        if effect not in ("pure", "read", "write"):
            raise TypeError(f'effect for {name} must be "pure", "read" or "write", not {effect!r}')
    f = _Fence(table, on_fork=on_fork, scratch=scratch, log=log, hooks=hooks, settings=settings, query=query)
    names = list(table)
    # An exact list (letters, digits, _ and -), which Claude Code compares name by name; the hooks
    # check the name again. With the query's own hooks inside, every tool: theirs may pick any.
    listed = "|".join(names) if all(re.match(r"^[A-Za-z0-9_-]+$", n) for n in names) else None

    def on(hook: Hook, inner: Optional[Sequence[Any]] = None) -> list[Any]:
        return [_matcher(None if inner else listed, hook, _longest(inner))]

    return {
        "UserPromptSubmit": [_matcher(None, f.prompted)],
        "PreToolUse": on(f.pre, f.inner_pre),
        "PostToolUse": on(f.post, f.inner_post),
        "PostToolUseFailure": on(f.failed),
        "Stop": [_matcher(None, f.settle)],
        "SubagentStop": [_matcher(None, f.settle)],
    }


def _allow(updated: dict[str, Any], why: str) -> dict[str, Any]:
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": why, "updatedInput": updated}}


def _deny(reason: str) -> dict[str, Any]:
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}


def _denied(out: Mapping[str, Any]) -> bool:
    specific = out.get("hookSpecificOutput")
    return isinstance(specific, dict) and specific.get("permissionDecision") == "deny"


def _where(h: Mapping[str, Any]) -> str:
    """A PreToolUse hook beside the fence, as a sentence names it: its file, its subagent, its matcher."""
    agent = f', which runs while the subagent "{h["agent"]}" runs' if h.get("agent") is not None else ""
    return "a PreToolUse hook in %s%s%s" % (h["source"], agent, ' (matcher "%s")' % h["matcher"] if h["matcher"] is not None else "")


@dataclasses.dataclass
class _Asked:
    """A call the fence is asked about: the tool, its effect and the input it would run with, and who asks."""

    name: str
    effect: str
    #: The call's tool_use_id, by which PostToolUse finds what PreToolUse kept of it.
    key: str
    args: dict[str, Any]
    agent: str
    agent_type: str
    cwd: Any


class _Fence:
    """The hooks of fence_hooks over one query, and what they share while it runs: the calls PreToolUse
    let through that PostToolUse ends (``pending``), where stand-ins write, the query's own hooks, and
    what has been said once."""

    def __init__(
        self,
        table: dict[str, str],
        *,
        on_fork: Optional[Callable[[str, dict[str, Any], Any], Any]],
        scratch: Optional[str],
        log: Optional[Callable[[str], None]],
        hooks: Optional[Mapping[str, Sequence[Any]]],
        settings: Optional[Mapping[str, Any]],
        query: Optional[Mapping[str, Any]],
    ) -> None:
        self.table = table
        self.on_fork = on_fork
        self.say: Callable[[str], None] = log or (lambda line: print("[shadowlap] " + line, file=sys.stderr))
        self.pending: dict[str, dict[str, Any]] = {}
        self.files = _Scratch(scratch)
        self.inner_pre = list((hooks or {}).get("PreToolUse") or [])
        self.inner_post = list((hooks or {}).get("PostToolUse") or [])
        self.places: dict[str, Any] = dict(settings or {})
        # The folder the session started in, where Claude Code reads the project's settings: the first hook's, unless with_fence said.
        self.project: Optional[str] = self.places.get("cwd")
        self.said: set[str] = set()
        self.greeted = False
        self.query = query

    async def greet(self) -> None:
        """The Claude Code CLI the SDK runs is a native program, which Shadowlap's preloads can't load
        into, so the network guard can't watch the connections it makes itself. The fence says so for
        it, once, as a preload says it loaded, with what the query leaves the CLI to reach
        (claude_reach): the run's summary names each, and ``--guard block`` fails the run unless there
        are none. From this process, the one the CLI's hooks answer in."""
        if self.greeted:
            return
        self.greeted = True
        body: dict[str, Any] = {"runtime": "claude-code", "pid": os.getpid(), "ppid": os.getppid(), "guard": "off", "capture": False}
        if self.query is not None:
            try:
                paths = claude_reach(self.query, {"cwd": self.project, **self.places}, {**os.environ, **(self.places.get("env") or {})}, os.environ.get("ANTHROPIC_BASE_URL"))
                # The sidecar keeps 20: the rest are counted in the last.
                body["reach"] = paths if len(paths) <= 20 else [*paths[:19], f"{len(paths) - 19} more"]
            except Exception as err:
                self.say(f"could not work out what the Claude Code CLI can reach: {err}")
        try:
            await _finish(_say_hello, body)
        except Exception as err:
            self.say(f"could not tell Shadowlap that the Claude Code CLI runs unguarded: {err}")

    def once(self, key: str, line: str) -> None:
        if key not in self.said:
            self.said.add(key)
            self.say(line)

    def stand_in(self, name: str, args: dict[str, Any], recorded: Any) -> Optional[dict[str, Any]]:
        """The harmless call that runs in place of a recorded write, as Claude Code accepts it; None where there is none."""
        if name == "Bash":
            cwd = _text(recorded.get(_CWD)) if isinstance(recorded, dict) else ""
            # Only what Claude Code tracks of a command: where it left the shell. The builtin, so a cd
            # function or alias the user's shell defines (one that lists the folder, or loads a project's
            # environment) runs nothing.
            return {**args, "command": "builtin cd -- %s 2>/dev/null || true" % _quote(cwd) if cwd else "true", "run_in_background": False}
        if name == "Write":
            return {"file_path": self.files.fresh("write"), "content": ""}
        if name == "Edit":
            # An edit with nothing to find creates a new file: the only edit Claude Code takes on a file nobody read.
            return {"file_path": self.files.fresh("edit"), "old_string": "", "new_string": "."}
        if name == "MultiEdit":
            return {"file_path": self.files.fresh("edit"), "edits": [{"old_string": "", "new_string": "."}]}
        return None

    def failing_bash(self, args: dict[str, Any], code: int, rest: str) -> dict[str, Any]:
        """A recorded Bash failure, reproduced: the same output, the same exit code."""
        printed = "cat -- %s" % _quote(self.files.write("output", rest)) if len(rest) > 16000 or "\0" in rest else "printf '%%s' %s" % _quote(rest)
        return {**args, "command": "%s; exit %d" % (printed, code), "run_in_background": False}

    def stub_output(self, name: str, args: dict[str, Any], output: Any) -> Any:
        if self.on_fork is not None:
            return self.on_fork(name, args, output)
        if isinstance(output, dict) and isinstance(output.get("filePath"), str) and isinstance(args.get("file_path"), str):
            return {**output, "filePath": args["file_path"]}
        return output

    def besides(self, name: str, agent_type: str) -> Optional[dict[str, Any]]:
        """A PreToolUse hook Claude Code runs beside the fence that picks ``name`` in the session or the
        subagent ``agent_type`` (a settings file's, a plugin's, a skill's or that subagent's), or None."""
        found = settings_pre_tool_use(self.places, self.project or os.getcwd())
        return next((h for h in found if matcher_picks(h["matcher"], name, "all") and hook_runs_for(h, agent_type)), None)

    def stand_in_or_refuse(self, name: str, agent_type: str, stand: dict[str, Any], why: str) -> dict[str, Any]:
        """A write the fence would hand a stand-in, refused instead when a hook beside the fence could
        rewrite its input after the fence: the recorded write would run again for real."""
        beside = self.besides(name, agent_type)
        if beside is None:
            return _allow(stand, why)
        reason = (
            f"shadowlap: {name} was not run again: {_where(beside)} runs beside Shadowlap's, and Claude Code takes the input from whichever hook answers last, "
            f"so it could run the recorded {name} again for real. The replay forks here. Give that hook to the query in its hooks option, where with_fence runs "
            "it inside the fence, or leave its file out for this agent (its setting_sources entry, or the plugin that holds it)."
        )
        self.once("beside:" + name, reason)
        return _deny(reason)

    async def fence(self, input_data: dict[str, Any], key: str, args: dict[str, Any]) -> dict[str, Any]:
        """The fence's own answer to a call, from the input the call would run with (the query's hooks' rewrite included)."""
        name = _text(input_data.get("tool_name"))
        c = _Asked(name=name, effect=self.table[name], key=key, args=args, agent=_text(input_data.get("agent_id")), agent_type=_text(input_data.get("agent_type")), cwd=input_data.get("cwd"))
        try:
            r = await _resolve_shielded(functools.partial(_resolve_tool, name, c.effect, args), _complete_call)
            return {} if r is None else await self.answer(c, r)
        except Exception as err:
            # A hook that raises lets the tool run unchanged, so nothing may escape: a write that
            # can't be recorded is refused (this could be a replay), and a read runs unrecorded.
            self.say(f"could not record {name}: {err}")
            if c.effect == "write":
                return _deny(f"shadowlap: {name} was not run: it is a write, and it could not be recorded ({err}). A write never runs unrecorded under Shadowlap, since this may be a replay.")
            return {}

    async def answer(self, c: _Asked, r: dict[str, Any]) -> dict[str, Any]:
        """The answer to a call, by what the sidecar said of it: run live, refused, stubbed, or replayed from the recording."""
        origin = r.get("origin")
        if origin == "live":
            return self.live(c, r)
        if origin == "blocked":
            return _deny(str(r["error"]["message"]))
        if origin == "stubbed":
            return await self.stubbed(c, r)
        if origin == "replayed":
            return self.replayed(c, r) if r.get("outcome") == "ok" else self.replayed_failure(c, r)
        return _deny(f"shadowlap: the sidecar answered {c.name} with an unknown origin; it was not run")

    def live(self, c: _Asked, r: dict[str, Any]) -> dict[str, Any]:
        """A call that runs as it is, recorded as it runs: PostToolUse ends it."""
        self.pending[c.key] = {"kind": "live", "call_no": r["callNo"], "name": c.name, "started": time.time(), "agent": c.agent, "cwd": c.cwd, "input": c.args}
        # Recorded as it runs; a replay of it will meet the same hook beside the fence, and refuse it.
        if c.effect == "write":
            beside = self.besides(c.name, c.agent_type)
            if beside is not None:
                self.once("record:" + c.name, f"{_where(beside)} runs beside Shadowlap's for {c.name}: a replay of this run refuses {c.name} rather than let that hook run it again for real. Give the hook to the query in its hooks option, where with_fence runs it inside the fence.")
        return {}

    async def stubbed(self, c: _Asked, r: dict[str, Any]) -> dict[str, Any]:
        """A write after the fork under ``--writes stub``: its stand-in runs, or it is refused where it has none, or where a hook beside the fence could run it."""
        stand = self.stand_in(c.name, c.args, None)
        if stand is None:
            await _finish(_complete_call, r["callNo"], {"outcome": "error", "error": {"name": "ShadowlapWriteBlocked", "message": f"{c.name} has no stand-in Claude Code takes, so it was refused instead of stubbed"}})
            return _deny(f"{c.name} was not run: write tools are stubbed after the fork (shadowlap replay --writes stub), and {c.name} can't be.")
        out = self.stand_in_or_refuse(c.name, c.agent_type, stand, "shadowlap: a write stubbed after the fork")
        if _denied(out):
            await _finish(_complete_call, r["callNo"], {"outcome": "error", "error": {"name": "ShadowlapWriteBlocked", "message": out["hookSpecificOutput"]["permissionDecisionReason"]}})
            return out
        self.pending[c.key] = {"kind": "stubbed", "call_no": r["callNo"], "name": c.name, "started": time.time(), "agent": c.agent, "input": c.args, "stand_in": stand}
        return out

    def replayed(self, c: _Asked, r: dict[str, Any]) -> dict[str, Any]:
        """A recorded call that answered: a read runs as it is, a write runs its stand-in, and the model gets the recorded output."""
        result = r.get("result")
        output = {k: v for k, v in result.items() if k != _CWD} if isinstance(result, dict) and _CWD in result else result
        if c.effect != "write":
            # A read runs as it is; the model gets the recorded output.
            self.pending[c.key] = {"kind": "replayed", "name": c.name, "agent": c.agent, "output": output, "input": c.args, "stand_in": None}
            return {}
        stand = self.stand_in(c.name, c.args, result)
        if stand is None:
            return _deny(f"shadowlap: {c.name} was not run again on replay: it is a write, and it has no stand-in Claude Code takes. The replay forks here.")
        out = self.stand_in_or_refuse(c.name, c.agent_type, stand, "shadowlap: a recorded call, replayed")
        if not _denied(out):
            self.pending[c.key] = {"kind": "replayed", "name": c.name, "agent": c.agent, "output": output, "input": c.args, "stand_in": stand}
        return out

    def replayed_failure(self, c: _Asked, r: dict[str, Any]) -> dict[str, Any]:
        """A recorded call that failed: an injected failure is refused with its message, a read runs and
        fails as it did, a Bash failure is reproduced, and any other write is refused with its error."""
        error = r.get("error") or {}
        if r.get("injected"):
            return _deny(str(error.get("message", "injected failure")))
        if c.effect != "write":
            return {}  # a read that failed: it runs, and fails as it did
        failure = _bash_failure(str(error.get("message", ""))) if c.name == "Bash" else None
        if failure is None:
            return _deny(str(error.get("message", "recorded failure")))
        stand = self.failing_bash(c.args, failure[0], failure[1])
        out = self.stand_in_or_refuse(c.name, c.agent_type, stand, "shadowlap: a recorded failure, replayed")
        if not _denied(out):
            self.pending[c.key] = {"kind": "failure", "name": c.name, "agent": c.agent, "input": c.args, "stand_in": stand}
        return out

    async def pre(self, input_data: dict[str, Any], tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
        if self.project is None:
            self.project = _text(input_data.get("cwd")) or None
        await self.greet()
        name = _text(input_data.get("tool_name"))
        # The query's own hooks first, as Claude Code would run them: a refusal of theirs stands, and
        # nothing runs, so nothing is recorded or fenced; a rewrite of theirs is what the call runs with.
        own = combine(await run_hooks(self.inner_pre, name, input_data, tool_use_id, context), "PreToolUse")
        if own.get("decision") in ("deny", "defer") or name not in self.table:
            return as_output(own, "PreToolUse")
        given = input_data.get("tool_input")
        args: dict[str, Any] = own["updatedInput"] if isinstance(own.get("updatedInput"), dict) else given if isinstance(given, dict) else {}
        out = await self.fence({**input_data, "tool_input": args}, tool_use_id or _text(input_data.get("tool_use_id")), args)
        mine = out.get("hookSpecificOutput")
        if not isinstance(mine, dict):
            return as_output(own, "PreToolUse")
        # The fence has the last word on the input; the more restrictive decision stands, a person's ask over its allow.
        decision = "deny" if mine.get("permissionDecision") == "deny" else "ask" if own.get("decision") == "ask" else "allow"
        reason = own["reason"] if decision == own.get("decision") and own.get("reason") is not None else str(mine.get("permissionDecisionReason"))
        merged = {k: v for k, v in own.items() if k != "updatedInput"}
        merged.update(decision=decision, reason=reason)
        if isinstance(mine.get("updatedInput"), dict):
            merged["updatedInput"] = mine["updatedInput"]
        return as_output(merged, "PreToolUse")

    async def lost(self, p: dict[str, Any], ran: Any) -> dict[str, Any]:
        """Another hook's rewrite came after the fence's stand-in, so Claude Code ran the call itself: a
        recorded write ran again for real. The model is not handed the recording as if nothing happened,
        a stubbed call is not kept as stubbed, and the session stops there."""
        field = _ACTS_ON.get(p["name"])
        what = " (%s: %s)" % (field, json.dumps(ran.get(field))) if field and isinstance(ran, dict) else ""
        line = (
            f"shadowlap: another PreToolUse hook replaced the stand-in Shadowlap gave {p['name']}, so Claude Code ran the call itself{what}: on a replay, that is the "
            "recorded call run again for real. The session stops here. A hook the fence doesn't run did it, one in a settings file, a plugin or managed settings: "
            "see Claude Agent SDK in docs/frameworks.md."
        )
        self.say(line)
        if p["kind"] == "stubbed":
            try:
                await _finish(_complete_call, p["call_no"], {"outcome": "error", "error": {"name": "ShadowlapFenceLost", "message": line}})
            except Exception as err:
                self.say(f"could not record that {p['name']} ran: {err}")
        return {"continue_": False, "stopReason": line, "systemMessage": line}

    async def theirs(self, call: tuple[dict[str, Any], Optional[str], Any], seen: Optional[tuple[dict[str, Any], Any]], mine: Optional[tuple[Any]]) -> dict[str, Any]:
        """The query's own PostToolUse hooks on what the model is to read (``seen``: the input and the
        output, as they ran on them when it was recorded), and the fence's output (``mine``) where they give none."""
        input_data, tool_use_id, context = call
        given = {**input_data, "tool_input": seen[0], "tool_response": seen[1]} if seen is not None else input_data
        own = combine(await run_hooks(self.inner_post, _text(input_data.get("tool_name")), given, tool_use_id, context), "PostToolUse")
        if own.get("output") is None and mine is not None:
            own["output"] = mine
        return as_output(own, "PostToolUse")

    async def post(self, input_data: dict[str, Any], tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
        p = self.pending.pop(tool_use_id or _text(input_data.get("tool_use_id")), None)
        call = (input_data, tool_use_id, context)
        if p is None:
            return await self.theirs(call, None, None)
        try:
            if p["kind"] != "live" and p.get("stand_in") is not None and _ran_other(p["name"], input_data.get("tool_input"), p["stand_in"]):
                return await self.lost(p, input_data.get("tool_input"))
            if p["kind"] == "replayed":
                return await self.theirs(call, (p["input"], p["output"]), (p["output"],))
            if p["kind"] == "failure":
                self.say(f"the replayed failure of {p['name']} ran without failing; the replay forks here")
                return await self.theirs(call, None, None)
            if p["kind"] == "live":
                await self.ran(p, input_data)
                return await self.theirs(call, None, None)
            output = self.stub_output(p["name"], p["input"], input_data.get("tool_response"))
            await _finish(_complete_call, p["call_no"], {"outcome": "ok", "result": output, "latencyMs": 0})
            return await self.theirs(call, (p["input"], output), (output,))
        except Exception as err:
            self.say(f"could not record the result of {p['name']}: {err}")
            return {}

    async def ran(self, p: dict[str, Any], input_data: dict[str, Any]) -> None:
        """A live call's output, recorded: with where a Bash command left the shell, part of what the
        model sees next, kept for the replay's stand-in."""
        output = input_data.get("tool_response")
        cwd = input_data.get("cwd")
        moved = p["name"] == "Bash" and isinstance(cwd, str) and isinstance(p["cwd"], str) and cwd != p["cwd"]
        result = {**output, _CWD: cwd} if moved and isinstance(output, dict) else output
        await _finish(_complete_call, p["call_no"], {"outcome": "ok", "result": result, "latencyMs": int((time.time() - p["started"]) * 1000)})

    async def failed(self, input_data: dict[str, Any], tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
        p = self.pending.pop(tool_use_id or _text(input_data.get("tool_use_id")), None)
        if p is None:
            return {}
        try:
            if p["kind"] != "live" and p.get("stand_in") is not None and _ran_other(p["name"], input_data.get("tool_input"), p["stand_in"]):
                return await self.lost(p, input_data.get("tool_input"))
            if p["kind"] in ("live", "stubbed"):
                error = _text(input_data.get("error")) or "the tool failed"
                serialized: dict[str, Any] = {"name": "ToolError", "message": error}
                code = re.match(r"^Exit code (\d+)", error)
                if code:
                    serialized["code"] = code.group(1)
                if input_data.get("is_interrupt") is True:
                    serialized["data"] = {"interrupted": True}
                await _finish(_complete_call, p["call_no"], {"outcome": "error", "error": serialized, "latencyMs": int((time.time() - p["started"]) * 1000)})
            elif p["kind"] == "replayed":
                self.say(f"the stand-in for {p['name']} failed; the replay forks here")
        except Exception as err:
            self.say(f"could not record the failure of {p['name']}: {err}")
        return {}

    async def settle(self, input_data: dict[str, Any], tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
        """Calls PreToolUse saw that never ran (a permission refused them): ended, so the recording has no hole."""
        agent = _text(input_data.get("agent_id"))
        for key, p in list(self.pending.items()):
            if p["agent"] != agent:
                continue
            del self.pending[key]
            if p["kind"] not in ("live", "stubbed"):
                continue
            try:
                await _finish(_complete_call, p["call_no"], {"outcome": "error", "error": {"name": "NotRun", "message": f"Claude Code did not run {p['name']}: a permission rule, can_use_tool or a person refused it"}})
            except Exception as err:
                self.say(f"could not record that {p['name']} did not run: {err}")
        return {}

    async def prompted(self, input_data: dict[str, Any], tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
        """The first prompt comes before any model call or tool: the CLI is running, and says hello then."""
        await self.greet()
        return {}


def with_fence(options: Opts, effects: Optional[Mapping[str, str]] = None, **fence: Any) -> Opts:
    """``options`` (a ``ClaudeAgentOptions``) with the fence's hooks in them:
    ``query(prompt=..., options=with_fence(options))``. The query's own PreToolUse and PostToolUse
    hooks run inside the fence's, first; its other hooks stay where they are, beside the fence's. Under
    Shadowlap, the CLI runs with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 unless the query's ``env``
    or this process's sets it: its updates, telemetry and error reports are connections the guard
    can't watch. Without Shadowlap the hooks answer as the query's own would and the environment is
    the query's, so the same options serve production."""
    if not dataclasses.is_dataclass(options) or isinstance(options, type):
        raise TypeError("with_fence: options must be a ClaudeAgentOptions")
    own: Mapping[str, Sequence[Any]] = getattr(options, "hooks", None) or {}
    given_hooks: Mapping[str, Sequence[Any]] = fence.pop("hooks", None) or {}
    inner = {event: [*own.get(event, []), *given_hooks.get(event, [])] for event in ("PreToolUse", "PostToolUse")}
    # The CLI's environment: the query's over this process's, as the SDK merges them.
    env: dict[str, str] = dict(getattr(options, "env", None) or {})
    has_env = any(f.name == "env" for f in dataclasses.fields(options))
    quiet = has_env and bool(os.environ.get("SHADOWLAP_URL")) and "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" not in {**os.environ, **env}
    if quiet:
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    extra = getattr(options, "extra_args", None) or {}
    plugins = [str(p["path"]) for p in getattr(options, "plugins", None) or [] if isinstance(p, dict) and isinstance(p.get("path"), str)]
    places: dict[str, Any] = {
        "sources": getattr(options, "setting_sources", None),
        "cwd": str(getattr(options, "cwd", None) or os.getcwd()),
        # ``--settings`` given through extra_args is one more settings file.
        "settings": [s for s in (getattr(options, "settings", None), extra.get("settings")) if s],
        "env": env,
        "add_dirs": [str(d) for d in getattr(options, "add_dirs", None) or []],
        "plugins": plugins,
    }
    places.update(fence.pop("settings", None) or {})
    query = {
        "tools": getattr(options, "tools", None),
        "disallowed_tools": list(getattr(options, "disallowed_tools", None) or []),
        "mcp_servers": getattr(options, "mcp_servers", None),
        "strict_mcp_config": getattr(options, "strict_mcp_config", False),
        "agents": getattr(options, "agents", None),
        "extra_args": extra,
        "plugins": list(getattr(options, "plugins", None) or []),
        **(fence.pop("query", None) or {}),
    }
    hooks: dict[str, list[Any]] = {event: list(matchers) for event, matchers in own.items() if event not in inner}
    for event, matchers in fence_hooks(effects, hooks=inner, settings=places, query=query, **fence).items():
        hooks[event] = hooks.get(event, []) + matchers
    return dataclasses.replace(options, hooks=hooks, **({"env": env} if quiet else {}))


_MCP_NAME_OTHER = re.compile(r"[^A-Za-z0-9_-]")


def _mcp_name_part(name: str) -> str:
    """A server's or a tool's name as Claude Code puts it in ``mcp__<server>__<tool>``: every character
    but a letter, a digit, ``_`` or ``-`` turned into ``_``, as the TypeScript adapter turns it."""
    return _MCP_NAME_OTHER.sub("_", name)


def with_effects(server: str, tools: Sequence[ToolT], effects: Mapping[str, Any]) -> list[ToolT]:
    """The tools of an in-process MCP server (``create_sdk_mcp_server``), recorded and fenced like any
    SDK tool under the name the model calls them by, ``mcp__<server>__<tool>``, with the tool's input
    as the call's arguments. Claude Code turns every character of either name but a letter, a digit,
    ``_`` and ``-`` into ``_``, and so does the recorded name: the ``look up`` tool of ``order desk``
    is ``mcp__order_desk__look_up``. The effects are keyed by each tool's own name::

        tools = with_effects("orders", [lookup_order, issue_refund], {"lookup_order": "read", "issue_refund": "write"})
        orders = create_sdk_mcp_server(name="orders", version="1.0.0", tools=tools)

    An effect is ``"read"``, ``"write"`` or ``"pure"``, or a dict ``{"effect": ..., "on_fork": ...,
    "trust": ...}``. A write after a fork answers as an MCP tool that failed (``is_error``), with the
    refusal as its text, so the model reads it and carries on; under ``--writes stub`` it answers
    ``on_fork(args)``, or a text saying the tool was not run."""
    missing = [str(getattr(t, "name", "?")) for t in tools if getattr(t, "name", None) not in effects]
    if missing:
        raise TypeError("with_effects: every tool needs an effect; missing for " + ", ".join(missing))
    out: list[ToolT] = []
    for t in tools:
        name = str(getattr(t, "name"))
        spec = effects[name]
        options: dict[str, Any] = dict(spec) if isinstance(spec, Mapping) else {"effect": spec}
        effect = options.pop("effect", None)
        on_fork = options.pop("on_fork", None)
        trust = options.pop("trust", None)
        if options:
            raise TypeError(f"with_effects: {name}: unknown option {sorted(options)[0]}")
        if effect not in ("pure", "read", "write"):
            raise TypeError(f'with_effects: {name}: effect must be "pure", "read" or "write", not {effect!r}')
        if trust is not None and trust not in ("trusted", "untrusted"):
            raise TypeError(f'with_effects: {name}: trust must be "trusted" or "untrusted", not {trust!r}')
        handler = _recorded_handler(f"mcp__{_mcp_name_part(server)}__{_mcp_name_part(name)}", name, str(effect), getattr(t, "handler"), on_fork, trust)
        if dataclasses.is_dataclass(t) and not isinstance(t, type):
            out.append(dataclasses.replace(t, handler=handler))
        else:
            copy: Any = type(t).__new__(type(t))
            copy.__dict__.update(vars(t))
            copy.handler = handler
            out.append(copy)
    return out


def _recorded_handler(recorded: str, name: str, effect: str, handler: Callable[[Any], Any], on_fork: Optional[Callable[[Any], Any]], trust: Optional[str]) -> Callable[[Any], Any]:
    """An MCP tool's handler, its calls recorded and fenced through the sidecar."""

    async def run(args: Any) -> Any:
        try:
            return await _call(recorded, name, effect, args, handler, on_fork, trust)
        except (ShadowlapWriteBlocked, ShadowlapInjectedFailure) as err:
            # As an MCP server answers a tool whose handler failed: a result the model reads.
            return {"content": [{"type": "text", "text": str(err)}], "is_error": True}

    return run


async def _call(recorded: str, name: str, effect: str, args: Any, handler: Callable[[Any], Any], on_fork: Optional[Callable[[Any], Any]], trust: Optional[str]) -> Any:
    r = await _resolve_shielded(functools.partial(_resolve_tool, recorded, effect, _check_args(recorded, args), trust), _complete_call)
    if r is None:
        return await handler(args)
    origin = r.get("origin")
    if origin == "replayed":
        if r.get("outcome") == "ok":
            return r.get("result")
        error = r.get("error") or {}
        if r.get("injected"):
            raise _injected(recorded, args, r["injected"], error)
        await _replay_cancellation(error)
        raise ReplayedError(error)
    if origin == "blocked":
        raise ShadowlapWriteBlocked(recorded, args, str((r.get("error") or {}).get("message", "")))
    if origin == "stubbed":
        value: Any = {"content": [{"type": "text", "text": f"{name} was not executed: write tools are stubbed after the fork (shadowlap replay --writes stub)."}]}
        if on_fork is not None:
            value = on_fork(args)
            if hasattr(value, "__await__"):
                value = await value
        await _finish(_complete_call, r["callNo"], {"outcome": "ok", "result": _recordable(recorded, value)})
        return value
    if origin != "live":
        raise RuntimeError(f"shadowlap sidecar answered {recorded} with an unknown origin {origin!r}; update the shadowlap package")
    started = time.time()
    try:
        result = await handler(args)
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as err:
        error_body = _cancelled_error(err) if _is_cancellation(err) else serialize_error(err)
        await _finish(_complete_call, r["callNo"], {"outcome": "error", "error": error_body, "latencyMs": int((time.time() - started) * 1000)})
        raise
    await _finish(_complete_call, r["callNo"], {"outcome": "ok", "result": _recordable(recorded, result), "latencyMs": int((time.time() - started) * 1000)})
    return result
