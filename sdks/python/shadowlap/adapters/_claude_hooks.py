"""Claude Code's hooks, as the Claude Agent SDK's fence (claude_agent_sdk.py) needs to know them: which
tools a matcher picks, the query's own PreToolUse and PostToolUse hooks run inside the fence's and
their answers put together as Claude Code puts several together, and the PreToolUse hooks of settings
files, which Claude Code runs beside the fence, where nothing can run them inside.

Claude Code runs every hook that matches a tool call at once. It decides between their permission
decisions by precedence (deny, then defer, ask and allow), but it takes ``updatedInput`` and
``updatedToolOutput`` from whichever hook answered last, which its documentation leaves open and which
a hook's own timing decides. A hook beside the fence can so put back the input of a recorded write the
fence turned into a stand-in, and the write runs again for real. Run inside the fence, the query's
hooks answer first, in the order they are given, and the fence has the last word. The Node twin is
packages/adapters/src/claude-hooks.ts."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from typing import Any, Callable, Optional, Union

from shadowlap import _async_library

#: The SDK's own default for a callback's timeout on PreToolUse and PostToolUse: the command hooks', 600 seconds.
DEFAULT_TIMEOUT_S = 600.0

#: One hook's answer: its output, or the timeout it ran out of.
Answer = Union[dict[str, Any], float]

RANK = {"allow": 1, "ask": 2, "defer": 3, "deny": 4}


def matcher_picks(matcher: Optional[str], tool: str, unsure: str = "none") -> bool:
    """Whether a matcher picks a tool, by Claude Code's rules: none, "" or "*" pick every tool; one made
    of letters, digits, ``_``, ``-``, spaces, ``,`` and ``|`` is a list of exact names; anything else is
    a regular expression, searched anywhere in the name. One that doesn't compile picks nothing, or with
    ``unsure="all"`` every tool, for a caller that must not miss one."""
    if matcher is None or matcher in ("", "*"):
        return True
    if re.match(r"^[A-Za-z0-9_ ,|-]+$", matcher):
        return any(m.strip() == tool for m in re.split(r"[|,]", matcher))
    try:
        return re.search(matcher, tool) is not None
    except re.error:
        return unsure == "all"


async def _answer(hook: Callable[..., Any], input_data: Any, tool_use_id: Optional[str], context: Any) -> dict[str, Any]:
    """One hook's answer. One that raises answers ``{}``, as it does under Claude Code: the call goes on
    as if it had said nothing; one that isn't a dict, or says ``async``, has no say either."""
    try:
        out = hook(input_data, tool_use_id, context)
        if inspect.isawaitable(out):
            out = await out
    except Exception:
        return {}
    return out if isinstance(out, dict) and out.get("async_") is not True and out.get("async") is not True else {}


async def run_hooks(matchers: Optional[Sequence[Any]], tool: str, input_data: Any, tool_use_id: Optional[str], context: Any) -> list[Answer]:
    """The callbacks of ``matchers`` (the SDK's HookMatcher: ``matcher``, ``hooks``, ``timeout`` in
    seconds) that pick ``tool``, run at once as Claude Code runs them, each within its matcher's
    timeout: under asyncio and trio (anyio runs on one of them), else one after another, untimed."""
    calls: list[tuple[Callable[..., Any], float]] = []
    for m in matchers or []:
        if not matcher_picks(getattr(m, "matcher", None), tool):
            continue
        timeout = getattr(m, "timeout", None)
        limit = float(timeout) if isinstance(timeout, (int, float)) and timeout > 0 else DEFAULT_TIMEOUT_S
        calls.extend((hook, limit) for hook in getattr(m, "hooks", None) or [])
    if not calls:
        return []
    library = _async_library()
    if library == "trio":
        import trio

        answers: list[Answer] = [{} for _ in calls]

        async def one_trio(i: int, hook: Callable[..., Any], limit: float) -> None:
            answers[i] = limit
            with trio.move_on_after(limit):
                answers[i] = await _answer(hook, input_data, tool_use_id, context)

        async with trio.open_nursery() as nursery:
            for i, (hook, limit) in enumerate(calls):
                nursery.start_soon(one_trio, i, hook, limit)
        return answers
    if library == "asyncio":

        async def one_asyncio(hook: Callable[..., Any], limit: float) -> Answer:
            try:
                return await asyncio.wait_for(_answer(hook, input_data, tool_use_id, context), limit)
            except asyncio.TimeoutError:
                return limit

        return list(await asyncio.gather(*(one_asyncio(hook, limit) for hook, limit in calls)))
    return [await _answer(hook, input_data, tool_use_id, context) for hook, _ in calls]


def _decision(out: Mapping[str, Any], specific: Mapping[str, Any]) -> Optional[tuple[str, Optional[str]]]:
    """The decision a hook's answer makes: ``permissionDecision``, or the older ``decision`` (approve, block)."""
    d = specific.get("permissionDecision")
    if d in RANK:
        reason = specific.get("permissionDecisionReason")
        return str(d), reason if isinstance(reason, str) else None
    if out.get("decision") in ("block", "approve"):
        reason = out.get("reason")
        return ("deny" if out["decision"] == "block" else "allow"), reason if isinstance(reason, str) else None
    return None


def combine(answers: Sequence[Answer], event: str) -> dict[str, Any]:
    """Hooks' answers put together: the most restrictive decision with its reason (deny, then defer, ask
    and allow); the last rewrite of the input or the output, in the order the hooks were given; every
    context and message, joined; a stop when any asks for one. A hook that ran out of time blocks a
    PreToolUse call, as it does under Claude Code, and has no say on a PostToolUse one. Keys:
    ``decision``, ``reason``, ``updatedInput``, ``output`` and ``mcpOutput`` (each ``(value,)``),
    ``additionalContext``, ``systemMessage``, ``stop`` (``{"reason": …}``) and ``suppressOutput``."""
    out: dict[str, Any] = {}
    contexts: list[str] = []
    messages: list[str] = []

    def decide(decision: str, reason: Optional[str]) -> None:
        if "decision" in out and RANK[decision] <= RANK[out["decision"]]:
            return
        out["decision"] = decision
        if reason is not None:
            out["reason"] = reason
        else:
            out.pop("reason", None)

    for a in answers:
        if not isinstance(a, dict):
            if event == "PreToolUse":
                decide("deny", "a PreToolUse hook did not answer within its timeout of %g seconds" % a)
            continue
        specific = a.get("hookSpecificOutput")
        specific = specific if isinstance(specific, dict) else {}
        d = _decision(a, specific) if event == "PreToolUse" else None
        if d is not None:
            decide(*d)
        if event == "PreToolUse" and isinstance(specific.get("updatedInput"), dict):
            out["updatedInput"] = specific["updatedInput"]
        if event == "PostToolUse" and "updatedToolOutput" in specific:
            out["output"] = (specific["updatedToolOutput"],)
        if event == "PostToolUse" and "updatedMCPToolOutput" in specific:
            out["mcpOutput"] = (specific["updatedMCPToolOutput"],)
        if isinstance(specific.get("additionalContext"), str) and specific["additionalContext"]:
            contexts.append(specific["additionalContext"])
        if isinstance(a.get("systemMessage"), str) and a["systemMessage"]:
            messages.append(a["systemMessage"])
        if a.get("continue_") is False or a.get("continue") is False:
            reason = a.get("stopReason")
            out.setdefault("stop", {"reason": reason} if isinstance(reason, str) else {})
        if a.get("suppressOutput") is True:
            out["suppressOutput"] = True
    if contexts:
        out["additionalContext"] = "\n".join(contexts)
    if messages:
        out["systemMessage"] = "\n".join(messages)
    return out


def as_output(c: Mapping[str, Any], event: str) -> dict[str, Any]:
    """A combined answer as a hook returns it to the SDK: ``{}`` when it says nothing."""
    specific: dict[str, Any] = {}
    if c.get("decision"):
        specific["permissionDecision"] = c["decision"]
        if c.get("reason") is not None:
            specific["permissionDecisionReason"] = c["reason"]
    if c.get("updatedInput") is not None:
        specific["updatedInput"] = c["updatedInput"]
    if c.get("output") is not None:
        specific["updatedToolOutput"] = c["output"][0]
    if c.get("mcpOutput") is not None:
        specific["updatedMCPToolOutput"] = c["mcpOutput"][0]
    if c.get("additionalContext"):
        specific["additionalContext"] = c["additionalContext"]
    out: dict[str, Any] = {}
    if c.get("systemMessage"):
        out["systemMessage"] = c["systemMessage"]
    if c.get("stop") is not None:
        # The Python SDK spells it continue_, which it sends as continue.
        out["continue_"] = False
        if c["stop"].get("reason"):
            out["stopReason"] = c["stop"]["reason"]
    if c.get("suppressOutput"):
        out["suppressOutput"] = True
    if specific:
        out["hookSpecificOutput"] = {"hookEventName": event, **specific}
    return out


# ---- settings files


#: The managed settings file an organization deploys, where Claude Code reads it on each system (Linux's otherwise).
_MANAGED = {"darwin": "/Library/Application Support/ClaudeCode/managed-settings.json", "win32": "C:\\Program Files\\ClaudeCode\\managed-settings.json"}


def _managed_file() -> str:
    return _MANAGED.get(sys.platform, "/etc/claude-code/managed-settings.json")


def _pre_tool_use(settings: Any, source: str) -> list[dict[str, Any]]:
    """The PreToolUse entries of one settings document that hold a hook, each with where it is and its matcher."""
    hooks = settings.get("hooks") if isinstance(settings, dict) else None
    entries = hooks.get("PreToolUse") if isinstance(hooks, dict) else None
    if not isinstance(entries, list):
        return []
    return [{"source": source, "matcher": e.get("matcher") if isinstance(e.get("matcher"), str) else None} for e in entries if isinstance(e, dict) and isinstance(e.get("hooks"), list) and e["hooks"]]


def _read(path: str) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def settings_pre_tool_use(places: Mapping[str, Any], cwd: str) -> list[dict[str, Any]]:
    """The PreToolUse hooks of the settings Claude Code loads for the query, read as they are now (Claude
    Code reloads a file that changes). ``places``: ``sources`` (the query's ``setting_sources``; all
    three when absent), ``settings`` (the query's, a file or JSON text, as the CLI's ``--settings``
    takes), ``env`` (the CLI's: ``CLAUDE_CONFIG_DIR``, ``HOME``) and ``managed_file`` (the managed
    settings file; the system's by default, None for none). Read: the user's file, the project's and
    the local one in ``cwd`` (the local one at the git repository's root too), the query's settings,
    and the managed file. A file that can't be read or parsed holds none: Claude Code skips it too."""
    env = {**os.environ, **(places.get("env") or {})}
    sources = places.get("sources")
    sources = ["user", "project", "local"] if sources is None else list(sources)
    files: list[str] = []
    if "user" in sources:
        home = env.get("HOME") or os.path.expanduser("~")
        files.append(os.path.join(env.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude"), "settings.json"))
    if "project" in sources:
        files.append(os.path.join(cwd, ".claude", "settings.json"))
    if "local" in sources:
        files.append(os.path.join(cwd, ".claude", "settings.local.json"))
        # Claude Code keeps the local file at the root of the git repository the folder is in.
        folder = cwd
        while True:
            if os.path.exists(os.path.join(folder, ".git")):
                if folder != cwd:
                    files.append(os.path.join(folder, ".claude", "settings.local.json"))
                break
            parent = os.path.dirname(folder)
            if parent == folder:
                break
            folder = parent
    managed = places["managed_file"] if "managed_file" in places else _managed_file()
    if managed:
        files.append(managed)
    found = [h for f in files for h in _pre_tool_use(_read(f), f)]
    given = places.get("settings")
    if isinstance(given, dict):
        found.extend(_pre_tool_use(given, "the query's settings option"))
    elif isinstance(given, str) and given.strip():
        try:
            found.extend(_pre_tool_use(json.loads(given), "the query's settings option"))
        except ValueError:
            path = os.path.join(cwd, given)
            found.extend(_pre_tool_use(_read(path), path))
    return found
