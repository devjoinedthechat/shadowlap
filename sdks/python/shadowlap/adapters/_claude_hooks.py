"""Claude Code's hooks, as the Claude Agent SDK's fence (claude_agent_sdk.py) needs to know them: which
tools a matcher picks, the query's own PreToolUse and PostToolUse hooks run inside the fence's and
their answers put together as Claude Code puts several together, and the PreToolUse hooks of settings
files, plugins, skills and subagents, which Claude Code runs beside the fence, where nothing can run them
inside.

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
from shadowlap.adapters._frontmatter import UNREADABLE, frontmatter

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


# ---- settings files, plugins, skills and subagents


#: The managed settings file an organization deploys, where Claude Code reads it on each system (Linux's otherwise).
_MANAGED = {"darwin": "/Library/Application Support/ClaudeCode/managed-settings.json", "win32": "C:\\Program Files\\ClaudeCode\\managed-settings.json"}

#: At most this many skill and subagent files are read for one query: a folder of thousands says nothing more.
MAX_COMPONENT_FILES = 500

#: What the query's own settings are called where a hook in them is named.
QUERY_SETTINGS = "the query's settings option"


def _managed_file() -> str:
    return _MANAGED.get(sys.platform, "/etc/claude-code/managed-settings.json")


def managed_file_of(places: Mapping[str, Any]) -> Optional[str]:
    """The managed settings file the places name (``managed_file``; None for none), or this system's."""
    return places["managed_file"] if "managed_file" in places else _managed_file()


def env_of(places: Mapping[str, Any]) -> dict[str, str]:
    """The environment the CLI runs with: the process's, with the query's on top, as the Python SDK merges them."""
    return {**os.environ, **(places.get("env") or {})}


def config_dir_of(env: Mapping[str, str]) -> str:
    """The folder Claude Code keeps its own files in: ``CLAUDE_CONFIG_DIR``, else ``~/.claude``."""
    return env.get("CLAUDE_CONFIG_DIR") or os.path.join(env.get("HOME") or os.path.expanduser("~"), ".claude")


def _sources(places: Mapping[str, Any]) -> list[str]:
    sources = places.get("sources")
    return ["user", "project", "local"] if sources is None else list(sources)


def _pre_tool_use(settings: Any, source: str, agent: Optional[str] = None) -> list[dict[str, Any]]:
    """The PreToolUse entries of one settings document that hold a hook, each with where it is, its
    matcher, and the subagent whose own it is."""
    hooks = settings.get("hooks") if isinstance(settings, dict) else None
    entries = hooks.get("PreToolUse") if isinstance(hooks, dict) else None
    if not isinstance(entries, list):
        return []
    return [
        {"source": source, "matcher": e.get("matcher") if isinstance(e.get("matcher"), str) else None, **({"agent": agent} if agent is not None else {})}
        for e in entries
        if isinstance(e, dict) and isinstance(e.get("hooks"), list) and e["hooks"]
    ]


def _read(path: str) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _list_dir(folder: str) -> list[str]:
    try:
        return os.listdir(folder)
    except OSError:
        return []


def settings_documents(places: Mapping[str, Any], cwd: str) -> list[dict[str, Any]]:
    """The settings documents Claude Code reads for the query, in its order, each ``{"source", "data",
    "managed"}``: the user's file (in ``CLAUDE_CONFIG_DIR``, else ``~/.claude``), the project's and the
    local one in its working folder (the Agent SDK reads both there, with no folder above it), the
    managed settings file and every ``*.json`` in ``managed-settings.d/`` beside it in alphabetical
    order, and the query's ``settings`` (a file or JSON text, as the CLI's ``--settings`` takes, or a
    list of them). A file that isn't there is left out; one that can't be parsed holds None."""
    env = env_of(places)
    sources = _sources(places)
    docs: list[dict[str, Any]] = []

    def add(path: str, managed: bool = False) -> None:
        if os.path.exists(path):
            docs.append({"source": path, "data": _read(path), "managed": managed})

    if "user" in sources:
        add(os.path.join(config_dir_of(env), "settings.json"))
    if "project" in sources:
        add(os.path.join(cwd, ".claude", "settings.json"))
    if "local" in sources:
        add(os.path.join(cwd, ".claude", "settings.local.json"))
    managed = managed_file_of(places)
    if managed:
        add(managed, True)
        # Claude Code merges the drop-ins after the file, in alphabetical order, skipping hidden files and any not ending in .json.
        dropins = os.path.join(os.path.dirname(managed), "managed-settings.d")
        for name in sorted(n for n in _list_dir(dropins) if n.endswith(".json") and not n.startswith(".")):
            add(os.path.join(dropins, name), True)
    given = places.get("settings")
    for one in given if isinstance(given, (list, tuple)) else [given]:
        if isinstance(one, dict):
            docs.append({"source": QUERY_SETTINGS, "data": one, "managed": False})
        elif isinstance(one, str) and one.strip():
            try:
                docs.append({"source": QUERY_SETTINGS, "data": json.loads(one), "managed": False})
            except ValueError:
                path = os.path.join(cwd, one)
                docs.append({"source": path, "data": _read(path), "managed": False})
    return docs


def project_dirs(cwd: str) -> list[str]:
    """The session's folder and each above it up to its repository's root, as project skills and
    subagents load; the folder alone outside a repository."""
    dirs: list[str] = []
    folder = cwd
    while True:
        dirs.append(folder)
        if os.path.exists(os.path.join(folder, ".git")):
            return dirs
        parent = os.path.dirname(folder)
        if parent == folder:
            return [cwd]
        folder = parent


def component_files(places: Mapping[str, Any], cwd: str) -> dict[str, list[str]]:
    """Where Claude Code loads skills and subagents from for the query, as the Agent SDK's documentation
    lists them: under ``user``, the skills and agents folders in ``CLAUDE_CONFIG_DIR`` (else
    ``~/.claude``); under ``project``, ``.claude/skills/`` and ``.claude/agents/`` in the working folder
    and each folder above it up to the repository's root, and in each added folder (``add_dirs``); the
    organization's skills in ``.claude/skills/`` beside the managed settings file; and the skills,
    agents and ``hooks/hooks.json`` of each local plugin the query loads (``plugins``). As
    ``{"skills", "agents", "plugin_hooks"}``."""
    env = env_of(places)
    sources = _sources(places)
    config = config_dir_of(env)
    managed = managed_file_of(places)
    plugins = [os.path.join(cwd, str(p)) for p in places.get("plugins") or []]
    added = [os.path.join(cwd, str(d)) for d in places.get("add_dirs") or []]
    project = [*project_dirs(cwd), *added] if "project" in sources else []
    skill_dirs = [
        *([os.path.join(config, "skills")] if "user" in sources else []),
        *(os.path.join(d, ".claude", "skills") for d in project),
        *([os.path.join(os.path.dirname(managed), ".claude", "skills")] if managed else []),
        *(os.path.join(p, "skills") for p in plugins),
    ]
    agent_dirs = [
        *([os.path.join(config, "agents")] if "user" in sources else []),
        *(os.path.join(d, ".claude", "agents") for d in project),
        *(os.path.join(p, "agents") for p in plugins),
    ]
    budget = [MAX_COMPONENT_FILES]
    skills: list[str] = []
    for folder in dict.fromkeys(skill_dirs):
        for name in sorted(_list_dir(folder)):
            path = os.path.join(folder, name, "SKILL.md")
            if budget[0] > 0 and not name.startswith(".") and os.path.exists(path):
                skills.append(path)
                budget[0] -= 1
    agents: list[str] = []

    def walk(folder: str, depth: int) -> None:
        for name in sorted(_list_dir(folder)):
            if budget[0] <= 0 or name.startswith("."):
                continue
            path = os.path.join(folder, name)
            if name.endswith(".md"):
                agents.append(path)
                budget[0] -= 1
            elif depth < 3 and os.path.isdir(path):
                walk(path, depth + 1)

    for folder in dict.fromkeys(agent_dirs):
        walk(folder, 0)
    plugin_hooks = [path for path in (os.path.join(p, "hooks", "hooks.json") for p in plugins) if os.path.exists(path)]
    return {"skills": skills, "agents": agents, "plugin_hooks": plugin_hooks}


def _read_text(path: str) -> Optional[str]:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, ValueError):
        return None


def component_pre_tool_use(places: Mapping[str, Any], cwd: str) -> list[dict[str, Any]]:
    """The PreToolUse hooks of the skills, subagents and local plugins the query loads. Claude Code keeps
    a skill's for the rest of the session once the skill is invoked, which can come at any turn, so each
    counts from the start; a subagent's run only while that subagent runs, so each is for that
    subagent's calls alone. A frontmatter whose hooks can't be read counts as a hook on every tool."""
    files = component_files(places, cwd)
    out: list[dict[str, Any]] = []

    def from_frontmatter(path: str, agent: bool) -> None:
        text = _read_text(path)
        keys = frontmatter(text) if text is not None else None
        if not keys:
            return
        name = keys.get("name")
        own = (name.strip() if isinstance(name, str) and name.strip() else os.path.basename(path)[: -len(".md")]) if agent else None
        hooks = keys.get("hooks", None)
        if hooks is None and "hooks" not in keys:
            return
        if hooks is UNREADABLE:
            out.append({"source": f"{path}, whose hooks Shadowlap could not read", "matcher": None, **({"agent": own} if own is not None else {})})
        else:
            out.extend(_pre_tool_use({"hooks": hooks}, path, own))

    for path in files["skills"]:
        from_frontmatter(path, False)
    for path in files["agents"]:
        from_frontmatter(path, True)
    for path in files["plugin_hooks"]:
        text = _read_text(path)
        try:
            data = json.loads(text or "")
        except ValueError:
            out.append({"source": f"{path}, which Shadowlap could not read", "matcher": None})
            continue
        out.extend(_pre_tool_use(data, path))
    return out


def settings_pre_tool_use(places: Mapping[str, Any], cwd: str) -> list[dict[str, Any]]:
    """The PreToolUse hooks Claude Code runs beside the fence for the query, read as they are now (Claude
    Code reloads a file that changes): those of every settings document it reads (settings_documents),
    and of the skills, subagents and local plugins it loads (component_pre_tool_use). ``places``:
    ``sources`` (the query's ``setting_sources``; all three when absent), ``settings``, ``env`` (the
    CLI's: ``CLAUDE_CONFIG_DIR``, ``HOME``), ``managed_file`` (the managed settings file; the system's by
    default, None for none, its folder holding the organization's other files), ``add_dirs`` and
    ``plugins`` (the local plugins' folders). A file that can't be read or parsed holds none, as Claude
    Code skips it; a frontmatter is the exception, read as a hook on every tool."""
    docs = settings_documents(places, cwd)
    return [h for d in docs for h in _pre_tool_use(d["data"], d["source"])] + component_pre_tool_use(places, cwd)


def hook_runs_for(hook: Mapping[str, Any], agent_type: str) -> bool:
    """Whether a hook runs for a call of the subagent ``agent_type`` (the main session's when empty)."""
    agent = hook.get("agent")
    if agent is None:
        return True
    # A plugin's subagent is named with its plugin's: ``plugin:agent``.
    return agent_type == agent or agent_type.endswith(f":{agent}")
