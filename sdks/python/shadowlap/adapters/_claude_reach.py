"""What the Claude Code CLI the Claude Agent SDK runs can connect to that shadowlap's network guard
doesn't watch. The CLI is a native program, so no preload loads into it. Its model calls come through
shadowlap (ANTHROPIC_BASE_URL), and so does WebSearch, a search the model API runs; the rest is the
query's to decide, and the files Claude Code reads its MCP servers from, as Claude Code's documentation
lists them: the model API itself when the CLI's ANTHROPIC_BASE_URL isn't shadowlap's (or it runs on
Amazon Bedrock, Vertex AI or Microsoft Foundry); WebFetch, unless disallowed; an MCP server over the
network, in the query's options or, unless ``strict_mcp_config``, the files Claude Code reads servers
from; the claude.ai connectors a claude.ai login brings; and its nonessential traffic, unless
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set, which with_fence does under shadowlap. Each is a few
words the run's summary lists; none left, and the run passes ``--guard block``. The twin of
claude-reach.ts in @shadowlap/adapters, held to the same cases."""

from __future__ import annotations

import json
import os
import re
import unicodedata
from collections.abc import Mapping
from typing import Any, Optional
from urllib.parse import urlsplit

from shadowlap.adapters._claude_hooks import QUERY_SETTINGS, component_files, hook_items, home_of, managed_file_of, project_dirs, settings_documents
from shadowlap.adapters._frontmatter import UNREADABLE, frontmatter

_MISSING = object()


def _on(v: Optional[str]) -> bool:
    """On, as Claude Code reads an on/off variable: 1, true, yes or on, in any case."""
    return v is not None and v.strip().lower() in ("1", "true", "yes", "on")


def _off(v: Optional[str]) -> bool:
    """Off, as it reads one: 0, false, no or off."""
    return v is not None and v.strip().lower() in ("0", "false", "no", "off")


def _filled(v: Optional[str]) -> bool:
    return v is not None and v.strip() != ""


def _quote(name: str) -> str:
    """A name from a config file, as the summary quotes it: short, and with no control or formatting characters."""
    short = name if len(name) <= 40 else name[:39] + "\u2026"
    return json.dumps("".join(" " if unicodedata.category(c) in ("Cc", "Cf") else c for c in short), ensure_ascii=False)


def program_of(command: str) -> Optional[str]:
    """The program a command line runs: its first word past any ``VAR=value``, by its file's name."""
    first = next((w for w in command.strip().split() if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w)), None)
    if first is None:
        return None
    name = re.split(r"[\\/]", first.strip("\"'"))[-1]
    return name[:40] or None


def watched_program(program: str) -> bool:
    """A program whose own connections the guard watches when the Claude Code CLI starts it: Python,
    which loads shadowlap's preload from the PYTHONPATH the CLI passes on. The CLI passes no
    NODE_OPTIONS, so a Node program it starts (node, npx) loads no preload, and a native one never does."""
    return re.match(r"^(python[0-9.]*|py)(\.exe)?$", program, re.IGNORECASE) is not None


def _shadowlap_mcp(command: str, args: Any) -> bool:
    """A stdio server that is shadowlap's own MCP proxy, which records and fences what it reaches."""
    words = [*command.strip().split(), *(a for a in (args if isinstance(args, list) else []) if isinstance(a, str))]
    program = program_of(command)
    if program is not None and re.match(r"^shadowlap(\.cmd)?$", program):
        return "mcp" in words
    return program is not None and re.match(r"^(npx|pnpx|bunx|pnpm|yarn)(\.cmd)?$", program) is not None and any(re.match(r"^(@shadowlap/cli|shadowlap)(@\S*)?$", w) for w in words) and "mcp" in words


def _plain(text: str) -> str:
    return "".join(" " if unicodedata.category(c) in ("Cc", "Cf") else c for c in text)


def unwatched_servers(servers: Any) -> list[tuple[str, str]]:
    """The servers of an MCP config (``{name: config}``) whose connections the guard can't watch, as
    ``(name, type)``: one over the network (``http``, ``sse``, any type but ``stdio`` and the SDK's
    in-process ``sdk``), and a ``stdio`` one unless it is Python, which loads the preload, or
    shadowlap's own MCP proxy. One with neither a command nor a URL connects nowhere. A stdio server's
    type says its program: ``stdio, npx``."""
    if not isinstance(servers, dict):
        return []
    out: list[tuple[str, str]] = []
    for name, c in servers.items():
        if not isinstance(c, dict):
            continue
        kind = c.get("type") if isinstance(c.get("type"), str) else "stdio" if isinstance(c.get("command"), str) else "http" if isinstance(c.get("url"), str) else None
        if kind is None or kind == "sdk":
            continue
        if kind != "stdio":
            out.append((str(name), kind[:20]))
            continue
        command = c["command"] if isinstance(c.get("command"), str) else ""
        program = program_of(command)
        if program is None or watched_program(program) or _shadowlap_mcp(command, c.get("args")):
            continue
        out.append((str(name), f"stdio, {_plain(program)}"))
    return out


#: The settings keys whose value is a command Claude Code runs itself, for a key, a token or a header.
HELPERS = ("apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "otelHeadersHelper")


def _read_json(path: str) -> Any:
    """A JSON file: what it holds, None when it can't be parsed, _MISSING when it isn't there."""
    if not os.path.exists(path):
        return _MISSING
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def claude_reach(query: Mapping[str, Any], places: Mapping[str, Any], cli_env: Mapping[str, str], shadowlap_base: Optional[str]) -> list[str]:
    """The CLI's reach, as the summary lists it: each path in a few words. ``query`` holds the options
    (``tools``, ``disallowed_tools``, ``mcp_servers``, ``strict_mcp_config``, ``agents``, ``extra_args``,
    ``plugins``), ``places`` where Claude Code reads its settings, ``cli_env`` the environment the CLI
    runs with, and ``shadowlap_base`` the ANTHROPIC_BASE_URL shadowlap gave the agent."""
    r = _Reach(query, places, cli_env)
    provider = _model_api(r, shadowlap_base)
    # WebFetch fetches each page itself; WebSearch's search is a model call, through shadowlap.
    disallowed = query.get("disallowed_tools") or []
    tools = query.get("tools")
    if "WebFetch" not in disallowed and (not isinstance(tools, list) or "WebFetch" in tools):
        r.out.append("WebFetch, which fetches each page itself")
    taken_over = _given_servers(r)
    # Servers the organization provides in its managed settings files; --strict-mcp-config leaves them out, unless managed-mcp.json is there.
    if not r.strict or taken_over:
        for d in r.docs:
            if d["managed"] and isinstance(d["data"], dict):
                r.servers(d["data"].get("managedMcpServers"), "managed settings")
    if not r.strict and not taken_over:
        _project_servers(r)
        _user_servers(r)
        for plugin in query.get("plugins") or []:
            _plugin_servers(r, plugin)
        _enabled_plugins(r)
        _agent_servers(r)
    _hooks_and_helpers(r)
    if not _connectors_off(r, provider, taken_over):
        r.out.append("claude.ai connectors, which a claude.ai login brings")
    if _telemetry_exported(r):
        r.out.append("its OpenTelemetry export (CLAUDE_CODE_ENABLE_TELEMETRY, to an otlp collector)")
    # Its own traffic: any value at all turns it off, 0 and false among them.
    if not _filled(cli_env.get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")):
        r.out.append("its nonessential traffic (updates, telemetry, error reports)")
    return list(dict.fromkeys(r.out))


class _Reach:
    """What claude_reach works from (the session's folder, the query, the settings it loads, the
    CLI's environment) and the reach it found so far, in the order the summary lists it."""

    def __init__(self, query: Mapping[str, Any], places: Mapping[str, Any], cli_env: Mapping[str, str]) -> None:
        self.query = query
        self.places = places
        self.cli_env = cli_env
        self.cwd: str = places.get("cwd") or os.getcwd()
        self.home = home_of(cli_env)
        sources = places.get("sources")
        self.sources: list[str] = ["user", "project", "local"] if sources is None else list(sources)
        self.docs = settings_documents(places, self.cwd)
        raw_extra = query.get("extra_args")
        self.extra: dict[str, Any] = raw_extra if isinstance(raw_extra, dict) else {}
        self.strict = query.get("strict_mcp_config") is True or "strict-mcp-config" in self.extra
        self.out: list[str] = []

    def short(self, path: str) -> str:
        """A file as the summary names it: from the session's folder, or the home folder (``~``), with ``/``
        between its parts on every system, and at most 60 characters."""
        cwd, home = self.cwd, self.home
        rel = path[len(cwd) + 1 :].replace(os.sep, "/") if path.startswith(cwd + os.sep) else "~/" + path[len(home) + 1 :].replace(os.sep, "/") if path.startswith(home + os.sep) else path
        return "…" + rel[-59:] if len(rel) > 60 else rel

    def named(self, source: str) -> str:
        return source if source.startswith("the query") else self.short(source)

    def servers(self, servers: Any, where: str = "") -> None:
        """Each server of an MCP config the guard can't watch, as the summary names it, with where it comes from."""
        for name, kind in unwatched_servers(servers):
            self.out.append(f"the MCP server {_quote(name)} ({kind}{', ' + where if where else ''})")

    def unreadable(self, what: str) -> None:
        self.out.append(f"{what}, which shadowlap could not read")

    def config_servers(self, given: Any, what: str, where: str = "") -> None:
        """The servers of an MCP config (mcp_config), or that ``what`` could not be read."""
        servers = self.mcp_config(given)
        if servers is None:
            self.unreadable(what)
        else:
            self.servers(servers, where)

    def mcp_config(self, given: Any) -> Optional[dict[str, Any]]:
        """An MCP config given as a dict, JSON text or a file (``--mcp-config``): its servers, or None when it can't be read."""
        value: Any = given
        text = str(given) if isinstance(given, os.PathLike) else given if isinstance(given, str) else None
        if text is not None:
            t = text.strip()
            if t.startswith("{"):
                try:
                    value = json.loads(t)
                except ValueError:
                    value = None
            else:
                value = _read_json(os.path.join(self.cwd, t))
        if not isinstance(value, dict):
            return None
        servers = value.get("mcpServers")
        return servers if isinstance(servers, dict) else value


def _model_api(r: _Reach, shadowlap_base: Optional[str]) -> Optional[str]:
    """The model API: shadowlap's, unless the CLI's environment sends it elsewhere. Returns the cloud platform it runs on, if one."""
    env = r.cli_env
    provider = next((label for var, label in (("CLAUDE_CODE_USE_BEDROCK", "Amazon Bedrock"), ("CLAUDE_CODE_USE_VERTEX", "Vertex AI"), ("CLAUDE_CODE_USE_FOUNDRY", "Microsoft Foundry")) if _on(env.get(var))), None)
    if provider:
        r.out.append(f"the model API on {provider}")
    elif shadowlap_base is not None and (env.get("ANTHROPIC_BASE_URL") or "").strip().rstrip("/") != shadowlap_base.strip().rstrip("/"):
        host = "api.anthropic.com"
        base_url = (env.get("ANTHROPIC_BASE_URL") or "").strip()
        if base_url:
            try:
                host = urlsplit(base_url).netloc or "another host"
            except ValueError:
                host = "another host"
        r.out.append(f"the model API at {host[:60]}, past shadowlap's ANTHROPIC_BASE_URL")
    return provider


def _given_servers(r: _Reach) -> bool:
    """The servers the CLI is given: the organization's managed-mcp.json, which takes over (only its
    servers load, and the managed settings' ones), or else the query's own, --mcp-config's and its
    subagents'. Returns whether managed-mcp.json took over."""
    managed = managed_file_of(r.places)
    managed_mcp_file = os.path.join(os.path.dirname(managed), "managed-mcp.json") if managed else None
    managed_mcp = _read_json(managed_mcp_file) if managed_mcp_file else _MISSING
    if managed_mcp is not _MISSING:
        if not isinstance(managed_mcp, dict):
            r.unreadable(f"the MCP servers in {r.short(managed_mcp_file or '')}")
        else:
            r.servers(managed_mcp.get("mcpServers"), "managed-mcp.json")
        return True
    given = r.query.get("mcp_servers")
    if isinstance(given, dict):
        r.servers(given)
    elif isinstance(given, (str, os.PathLike)) and str(given).strip():
        # A path to a config file or inline JSON, passed to --mcp-config as it is.
        r.config_servers(given, "the MCP servers of mcp_servers")
    if r.extra.get("mcp-config") is not None:
        r.config_servers(r.extra["mcp-config"], "the MCP servers of --mcp-config", "--mcp-config")
    # A subagent of the query's own may bring a server with it.
    agents = r.query.get("agents")
    if isinstance(agents, dict):
        for agent, definition in agents.items():
            specs = definition.get("mcpServers") if isinstance(definition, dict) else getattr(definition, "mcpServers", None)
            for spec in specs if isinstance(specs, list) else []:
                r.servers(spec, f"subagent {_quote(str(agent))}")
    return False


def _project_servers(r: _Reach) -> None:
    """A project's .mcp.json, which an SDK session loads without asking."""
    if "project" not in r.sources:
        return
    for folder in project_dirs(r.cwd):
        path = os.path.join(folder, ".mcp.json")
        data = _read_json(path)
        if data is not _MISSING:
            r.config_servers(data, f"the MCP servers in {r.short(path)}", r.short(path))


def _user_servers(r: _Reach) -> None:
    """The user's and the local scope's servers, in .claude.json: read whatever setting_sources says.
    The local scope's are kept under the folder they were added in: this one or one above it."""
    user_file = os.path.join(r.cli_env.get("CLAUDE_CONFIG_DIR") or r.home, ".claude.json")
    user = _read_json(user_file)
    if user is None:
        r.unreadable(f"the MCP servers in {r.short(user_file)}")
        return
    if not isinstance(user, dict):
        return
    r.servers(user.get("mcpServers"), r.short(user_file))
    raw_projects = user.get("projects")
    projects: dict[str, Any] = raw_projects if isinstance(raw_projects, dict) else {}
    folder = r.cwd
    while True:
        p = projects.get(folder)
        if isinstance(p, dict):
            r.servers(p.get("mcpServers"), f"local scope in {r.short(user_file)}")
        parent = os.path.dirname(folder)
        if parent == folder:
            break
        folder = parent


def _plugin_servers(r: _Reach, plugin: Any) -> None:
    """A local plugin's servers: its .mcp.json, and those its manifest names, inline or in a file."""
    if not isinstance(plugin, dict) or not isinstance(plugin.get("path"), str) or plugin.get("skipMcpDiscovery") is True:
        return
    root = os.path.join(r.cwd, plugin["path"])
    label = f"plugin {_quote(os.path.basename(os.path.normpath(root)))}"
    own = _read_json(os.path.join(root, ".mcp.json"))
    r.config_servers({} if own is _MISSING else own, f"the MCP servers of the {label}", label)
    manifest = _read_json(os.path.join(root, ".claude-plugin", "plugin.json"))
    if manifest is None:
        r.unreadable(f"the manifest of the {label}")
        return
    if not isinstance(manifest, dict) or "mcpServers" not in manifest:
        return
    entries = manifest["mcpServers"] if isinstance(manifest["mcpServers"], list) else [manifest["mcpServers"]]
    for entry in entries:
        if isinstance(entry, str):
            found = _read_json(os.path.join(root, entry))
            servers = r.mcp_config(found) if found is not _MISSING else None
        else:
            servers = entry if isinstance(entry, dict) else None
        if servers is None:
            r.unreadable(f"the MCP servers of the {label}")
        else:
            r.servers(servers, label)


def _enabled_plugins(r: _Reach) -> None:
    """The plugins a settings file enables: their servers come from where Claude Code installed them."""
    for d in r.docs:
        enabled = d["data"].get("enabledPlugins") if isinstance(d["data"], dict) else None
        if isinstance(enabled, dict) and any(v is True for v in enabled.values()):
            where = d["source"] if d["source"] == QUERY_SETTINGS else r.short(d["source"])
            r.out.append(f"the MCP servers of the plugins {where} enables")


def _agent_servers(r: _Reach) -> None:
    """A subagent's frontmatter may bring a server with it."""
    for path in component_files(r.places, r.cwd)["agents"]:
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except (OSError, ValueError):
            continue
        keys = frontmatter(text)
        if not keys or "mcpServers" not in keys:
            continue
        value = keys["mcpServers"]
        if value is UNREADABLE:
            r.unreadable(f"the MCP servers in {r.short(path)}")
            continue
        for spec in value if isinstance(value, list) else [value]:
            r.servers(spec, r.short(path))


def _hooks_and_helpers(r: _Reach) -> None:
    """Hooks Claude Code runs itself: an http one posts to its URL from the CLI, a command one runs a
    program the CLI starts, which loads no preload but Python's. Then the commands a settings file
    names for a key, a token or a header, which the CLI runs itself."""
    for h in hook_items(r.places, r.cwd):
        if h["type"] == "unreadable":
            r.unreadable(f"the hooks in {r.named(h['source'])}")
        elif h["type"] == "http" and "url" in h:
            try:
                host = urlsplit(h["url"]).netloc[:60] or "its URL"
            except ValueError:
                host = "its URL"
            r.out.append(f"the HTTP hook in {r.named(h['source'])} ({_plain(host)})")
        elif h["type"] == "command" and "command" in h:
            program = program_of(h["command"])
            if program is not None and not watched_program(program):
                r.out.append(f"the command hook {_plain(program)} in {r.named(h['source'])}")
    for d in r.docs:
        if not isinstance(d["data"], dict):
            continue
        for key in HELPERS:
            command = d["data"].get(key)
            program = program_of(command) if isinstance(command, str) else None
            if program is not None and not watched_program(program):
                r.out.append(f"the {key} command {_plain(program)} in {r.named(d['source'])}")


def _connectors_off(r: _Reach, provider: Optional[str], taken_over: bool) -> bool:
    """Whether the claude.ai connectors stay off: Claude Code fetches them only for a claude.ai login."""
    env, docs = r.cli_env, r.docs
    return (
        r.strict
        or _off(env.get("ENABLE_CLAUDEAI_MCP_SERVERS"))
        or any(isinstance(d["data"], dict) and d["data"].get("disableClaudeAiConnectors") is True for d in docs)
        or _filled(env.get("ANTHROPIC_API_KEY"))
        or _filled(env.get("ANTHROPIC_AUTH_TOKEN"))
        or _filled(env.get("ANTHROPIC_PROFILE"))
        or any(isinstance(d["data"], dict) and isinstance(d["data"].get("apiKeyHelper"), str) and d["data"]["apiKeyHelper"].strip() != "" for d in docs)
        or provider is not None
        # managed-mcp.json suppresses them, unless the organization's own settings allow them beside it.
        or (taken_over and not any(d["managed"] and isinstance(d["data"], dict) and d["data"].get("allowAllClaudeAiMcps") is True for d in docs))
    )


def _telemetry_exported(r: _Reach) -> bool:
    """Its OpenTelemetry export, which no nonessential-traffic switch turns off: on with
    CLAUDE_CODE_ENABLE_TELEMETRY, in the environment or the env of a settings file that may set it (a
    repository's may not), to a collector an otlp exporter sends to."""
    otel_docs = [d for d in r.docs if d.get("scope") in ("user", "managed", "query")]

    def values(name: str) -> list[str]:
        found = [r.cli_env.get(name)] + [d["data"]["env"].get(name) if isinstance(d["data"], dict) and isinstance(d["data"].get("env"), dict) else None for d in otel_docs]
        return [v for v in found if isinstance(v, str)]

    def otlp(name: str) -> bool:
        return any("otlp" in [e.strip().lower() for e in v.split(",")] for v in values(name))

    traces = any(_on(v) for v in [*values("CLAUDE_CODE_ENHANCED_TELEMETRY_BETA"), *values("ENABLE_ENHANCED_TELEMETRY_BETA")])
    return any(_on(v) for v in values("CLAUDE_CODE_ENABLE_TELEMETRY")) and (otlp("OTEL_METRICS_EXPORTER") or otlp("OTEL_LOGS_EXPORTER") or (traces and otlp("OTEL_TRACES_EXPORTER")))
