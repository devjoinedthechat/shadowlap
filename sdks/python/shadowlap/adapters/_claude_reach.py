"""What the Claude Code CLI the Claude Agent SDK runs can connect to that Shadowlap's network guard
doesn't watch. The CLI is a native program, so no preload loads into it. Its model calls come through
Shadowlap (ANTHROPIC_BASE_URL), and so does WebSearch, a search the model API runs; the rest is the
query's to decide, and the files Claude Code reads its MCP servers from, as Claude Code's documentation
lists them: the model API itself when the CLI's ANTHROPIC_BASE_URL isn't Shadowlap's (or it runs on
Amazon Bedrock, Vertex AI or Microsoft Foundry); WebFetch, unless disallowed; an MCP server over the
network, in the query's options or, unless ``strict_mcp_config``, the files Claude Code reads servers
from; the claude.ai connectors a claude.ai login brings; and its nonessential traffic, unless
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set, which with_fence does under Shadowlap. Each is a few
words the run's summary lists; none left, and the run passes ``--guard block``. The twin of
claude-reach.ts in @shadowlap/adapters, held to the same cases."""

from __future__ import annotations

import json
import os
import unicodedata
from collections.abc import Mapping
from typing import Any, Optional
from urllib.parse import urlsplit

from shadowlap.adapters._claude_hooks import QUERY_SETTINGS, component_files, managed_file_of, project_dirs, settings_documents
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


def network_servers(servers: Any) -> list[tuple[str, str]]:
    """The servers of an MCP config (``{name: config}``) that Claude Code connects to over the network,
    as ``(name, type)``: any but a ``stdio`` one (a ``command`` with no ``type``) and the SDK's in-process
    ones (``sdk``). One with neither a command nor a URL connects nowhere."""
    if not isinstance(servers, dict):
        return []
    out: list[tuple[str, str]] = []
    for name, c in servers.items():
        if not isinstance(c, dict):
            continue
        kind = c.get("type") if isinstance(c.get("type"), str) else "stdio" if isinstance(c.get("command"), str) else "http" if isinstance(c.get("url"), str) else None
        if kind is not None and kind not in ("stdio", "sdk"):
            out.append((str(name), kind[:20]))
    return out


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
    runs with, and ``shadowlap_base`` the ANTHROPIC_BASE_URL Shadowlap gave the agent."""
    cwd = places.get("cwd") or os.getcwd()
    home = cli_env.get("HOME") or os.path.expanduser("~")
    sources = places.get("sources")
    sources = ["user", "project", "local"] if sources is None else list(sources)

    def short(path: str) -> str:
        """A file as the summary names it: from the session's folder, or the home folder (``~``), and at most 60 characters."""
        rel = path[len(cwd) + 1 :] if path.startswith(cwd + os.sep) else "~" + os.sep + path[len(home) + 1 :] if path.startswith(home + os.sep) else path
        return "…" + rel[-59:] if len(rel) > 60 else rel

    out: list[str] = []

    def server(entry: tuple[str, str], where: str = "") -> None:
        out.append(f"the MCP server {_quote(entry[0])} ({entry[1]}{', ' + where if where else ''})")

    def unreadable(what: str) -> None:
        out.append(f"{what}, which Shadowlap could not read")

    docs = settings_documents(places, cwd)
    raw_extra = query.get("extra_args")
    extra: dict[str, Any] = raw_extra if isinstance(raw_extra, dict) else {}
    strict = query.get("strict_mcp_config") is True or "strict-mcp-config" in extra

    # The model API: Shadowlap's, unless the CLI's environment sends it elsewhere.
    provider = next((label for var, label in (("CLAUDE_CODE_USE_BEDROCK", "Amazon Bedrock"), ("CLAUDE_CODE_USE_VERTEX", "Vertex AI"), ("CLAUDE_CODE_USE_FOUNDRY", "Microsoft Foundry")) if _on(cli_env.get(var))), None)
    if provider:
        out.append(f"the model API on {provider}")
    elif shadowlap_base is not None and (cli_env.get("ANTHROPIC_BASE_URL") or "").strip().rstrip("/") != shadowlap_base.strip().rstrip("/"):
        host = "api.anthropic.com"
        base_url = (cli_env.get("ANTHROPIC_BASE_URL") or "").strip()
        if base_url:
            try:
                host = urlsplit(base_url).netloc or "another host"
            except ValueError:
                host = "another host"
        out.append(f"the model API at {host[:60]}, past Shadowlap's ANTHROPIC_BASE_URL")

    # WebFetch fetches each page itself; WebSearch's search is a model call, through Shadowlap.
    disallowed = query.get("disallowed_tools") or []
    tools = query.get("tools")
    if "WebFetch" not in disallowed and (not isinstance(tools, list) or "WebFetch" in tools):
        out.append("WebFetch, which fetches each page itself")

    def mcp_config(given: Any) -> Optional[dict[str, Any]]:
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
                value = _read_json(os.path.join(cwd, t))
        if not isinstance(value, dict):
            return None
        servers = value.get("mcpServers")
        return servers if isinstance(servers, dict) else value

    managed = managed_file_of(places)
    managed_mcp_file = os.path.join(os.path.dirname(managed), "managed-mcp.json") if managed else None
    managed_mcp = _read_json(managed_mcp_file) if managed_mcp_file else _MISSING
    taken_over = managed_mcp is not _MISSING
    if taken_over:
        # The organization's managed-mcp.json: only its servers load, and the provided ones below.
        if not isinstance(managed_mcp, dict):
            unreadable(f"the MCP servers in {short(managed_mcp_file or '')}")
        else:
            for s in network_servers(managed_mcp.get("mcpServers")):
                server(s, "managed-mcp.json")
    else:
        given = query.get("mcp_servers")
        if isinstance(given, dict):
            for s in network_servers(given):
                server(s)
        elif isinstance(given, (str, os.PathLike)) and str(given).strip():
            # A path to a config file or inline JSON, passed to --mcp-config as it is.
            servers = mcp_config(given)
            if servers is None:
                unreadable("the MCP servers of mcp_servers")
            else:
                for s in network_servers(servers):
                    server(s)
        if extra.get("mcp-config") is not None:
            servers = mcp_config(extra["mcp-config"])
            if servers is None:
                unreadable("the MCP servers of --mcp-config")
            else:
                for s in network_servers(servers):
                    server(s, "--mcp-config")
        # A subagent of the query's own may bring a server with it.
        agents = query.get("agents")
        if isinstance(agents, dict):
            for agent, definition in agents.items():
                specs = definition.get("mcpServers") if isinstance(definition, dict) else getattr(definition, "mcpServers", None)
                for spec in specs if isinstance(specs, list) else []:
                    for s in network_servers(spec):
                        server(s, f"subagent {_quote(str(agent))}")
    # Servers the organization provides in its managed settings files; --strict-mcp-config leaves them out, unless managed-mcp.json is there.
    if not strict or taken_over:
        for d in docs:
            if d["managed"] and isinstance(d["data"], dict):
                for s in network_servers(d["data"].get("managedMcpServers")):
                    server(s, "managed settings")
    if not strict and not taken_over:
        # A project's .mcp.json, which an SDK session loads without asking.
        if "project" in sources:
            for folder in project_dirs(cwd):
                path = os.path.join(folder, ".mcp.json")
                data = _read_json(path)
                if data is _MISSING:
                    continue
                servers = mcp_config(data)
                if servers is None:
                    unreadable(f"the MCP servers in {short(path)}")
                else:
                    for s in network_servers(servers):
                        server(s, short(path))
        # The user's and the local scope's servers, in .claude.json: read whatever setting_sources says.
        user_file = os.path.join(cli_env.get("CLAUDE_CONFIG_DIR") or home, ".claude.json")
        user = _read_json(user_file)
        if user is None:
            unreadable(f"the MCP servers in {short(user_file)}")
        elif isinstance(user, dict):
            for s in network_servers(user.get("mcpServers")):
                server(s, short(user_file))
            # The local scope's, kept under the folder they were added in: this one or one above it.
            raw_projects = user.get("projects")
            projects: dict[str, Any] = raw_projects if isinstance(raw_projects, dict) else {}
            folder = cwd
            while True:
                p = projects.get(folder)
                if isinstance(p, dict):
                    for s in network_servers(p.get("mcpServers")):
                        server(s, f"local scope in {short(user_file)}")
                parent = os.path.dirname(folder)
                if parent == folder:
                    break
                folder = parent
        # The local plugins the query loads.
        for plugin in query.get("plugins") or []:
            if not isinstance(plugin, dict) or not isinstance(plugin.get("path"), str) or plugin.get("skipMcpDiscovery") is True:
                continue
            root = os.path.join(cwd, plugin["path"])
            label = f"plugin {_quote(os.path.basename(os.path.normpath(root)))}"
            own = _read_json(os.path.join(root, ".mcp.json"))
            servers = {} if own is _MISSING else mcp_config(own)
            if servers is None:
                unreadable(f"the MCP servers of the {label}")
            else:
                for s in network_servers(servers):
                    server(s, label)
            manifest = _read_json(os.path.join(root, ".claude-plugin", "plugin.json"))
            if manifest is None:
                unreadable(f"the manifest of the {label}")
            elif isinstance(manifest, dict) and "mcpServers" in manifest:
                entries = manifest["mcpServers"] if isinstance(manifest["mcpServers"], list) else [manifest["mcpServers"]]
                for entry in entries:
                    if isinstance(entry, str):
                        found = _read_json(os.path.join(root, entry))
                        servers = mcp_config(found) if found is not _MISSING else None
                    else:
                        servers = entry if isinstance(entry, dict) else None
                    if servers is None:
                        unreadable(f"the MCP servers of the {label}")
                    else:
                        for s in network_servers(servers):
                            server(s, label)
        # The plugins a settings file enables: their servers come from where Claude Code installed them.
        for d in docs:
            enabled = d["data"].get("enabledPlugins") if isinstance(d["data"], dict) else None
            if isinstance(enabled, dict) and any(v is True for v in enabled.values()):
                where = d["source"] if d["source"] == QUERY_SETTINGS else short(d["source"])
                out.append(f"the MCP servers of the plugins {where} enables")
        # A subagent's frontmatter may bring a server with it.
        for path in component_files(places, cwd)["agents"]:
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
                unreadable(f"the MCP servers in {short(path)}")
                continue
            for spec in value if isinstance(value, list) else [value]:
                for s in network_servers(spec):
                    server(s, short(path))
    # The claude.ai connectors: Claude Code fetches them only for a claude.ai login.
    connectors_off = (
        strict
        or _off(cli_env.get("ENABLE_CLAUDEAI_MCP_SERVERS"))
        or any(isinstance(d["data"], dict) and d["data"].get("disableClaudeAiConnectors") is True for d in docs)
        or _filled(cli_env.get("ANTHROPIC_API_KEY"))
        or _filled(cli_env.get("ANTHROPIC_AUTH_TOKEN"))
        or _filled(cli_env.get("ANTHROPIC_PROFILE"))
        or any(isinstance(d["data"], dict) and isinstance(d["data"].get("apiKeyHelper"), str) and d["data"]["apiKeyHelper"].strip() != "" for d in docs)
        or provider is not None
        # managed-mcp.json suppresses them, unless the organization's own settings allow them beside it.
        or (taken_over and not any(d["managed"] and isinstance(d["data"], dict) and d["data"].get("allowAllClaudeAiMcps") is True for d in docs))
    )
    if not connectors_off:
        out.append("claude.ai connectors, which a claude.ai login brings")
    # Its own traffic: any value at all turns it off, 0 and false among them.
    if not _filled(cli_env.get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")):
        out.append("its nonessential traffic (updates, telemetry, error reports)")
    return list(dict.fromkeys(out))
