"""The `shadowlap mcp --listen` proxies of this user's, for the network guard (sitecustomize.py).

A proxy records the tool calls it carries, so reaching one bypasses nothing. It registers while it
runs, in the folder the command that started the agent names (SHADOWLAP_MCP_REGISTRY: mcp in
Shadowlap's home folder, ~/.shadowlap or SHADOWLAP_HOME), and the guard reads it when the agent
connects, so a proxy started after the agent counts too. The CLI writes the files
(src/mcp-proxies.ts), and the Node guard reads them as this does (node-proxies.mjs).

A registration counts only when it is this user's alone, in a folder that is too, names the process
it is filed under, which runs, and a loopback address, and its proxy records the agent's run or each
session's own. Even then, a connection goes through only once what answers at that address proves
it holds the key in the registration, which its proxy alone keeps, or when nothing listens there, as
when localhost names two addresses: then it fails, as it would. So one a killed proxy left lets no
connection reach anything, even once another process has its id.
"""

from __future__ import annotations

import json
import os
import re
import stat
import sys

# Typing's names for mypy alone (mypy.ini beside this file): at run time the guard imports nothing it needn't.
TYPE_CHECKING = False
if TYPE_CHECKING:
    import socket
    from collections.abc import Sequence
    from typing import Any, Callable

# Where a proxy answers a challenge (src/mcp-proxies.ts).
PROOF_PATH = "/.well-known/shadowlap-proxy"
# How long a proxy, on this machine, has to answer one once connected.
PROOF_SECONDS = 2.0
# How long the connection to it may take. On this machine it is taken or refused at once, but Windows
# tries again for about two seconds before it says refused.
CONNECT_SECONDS = 5.0
# A proof's answer is a short HTTP response: more than this is not one.
_ANSWER_MAX = 4096
_NAME = re.compile(r"^(\d+)\.json$")
_KEY = re.compile(r"^[0-9a-f]{32}$")
_IPV4 = re.compile(r"^127(?:\.\d{1,3}){3}$")
_MAPPED = re.compile(r"^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$")


def is_loopback_host(hostname: str) -> bool:
    """Whether a host is this machine: localhost, 127.0.0.0/8, or ::1, also as an IPv4-mapped address (src/loopback.ts)."""
    host = re.sub(r"^\[|\]$", "", hostname.lower())
    if host.endswith("."):
        host = host[:-1]
    if host in ("localhost", "::1"):
        return True
    if _IPV4.match(host):
        return all(int(n) <= 255 for n in host.split("."))
    mapped = _MAPPED.match(host)
    return mapped is not None and int(mapped.group(1), 16) >> 8 == 127


def run_of(url: str, run_id: str) -> str:
    """The run a sidecar's address and a run id name, as a registration names the run its proxy records into: a digest, which holds no session token."""
    import hashlib

    base = url[:-1] if url.endswith("/") else url
    return hashlib.sha256(("%s\n%s" % (base, run_id)).encode("utf-8")).hexdigest()


def _alone(st: os.stat_result, folder: bool) -> bool:
    """Whether a folder or file is this user's alone: of its kind, not a link, this user's, and no one
    else's to read. Ownership and modes are POSIX ideas; Windows keeps home folders private."""
    if stat.S_ISLNK(st.st_mode) or not (stat.S_ISDIR(st.st_mode) if folder else stat.S_ISREG(st.st_mode)):
        return False
    getuid = getattr(os, "getuid", None)
    return getuid is None or (st.st_uid == getuid() and st.st_mode & 0o077 == 0)


def _alive(pid: int) -> bool:
    """Whether a process with this id runs; one of another user's counts."""
    if sys.platform == "win32":
        # os.kill would end the process: Windows is asked whether it has one with this id, still running.
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: another user's
        try:
            code = wintypes.DWORD()
            return not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    else:
        try:
            os.kill(pid, 0)
        except PermissionError:
            return True
        except OSError:
            return False
        return True


def _registration(j: Any, pid: int) -> bool:
    """Whether a registration is one a proxy wrote, filed under `pid`, a process id the system can have."""
    if not isinstance(j, dict) or j.get("v") != 1 or j.get("pid") != pid or not 0 < pid < 2**31:
        return False
    host, port, key, run = j.get("host"), j.get("port"), j.get("key"), j.get("run")
    if not isinstance(host, str) or not is_loopback_host(host) or type(port) is not int or not 1 <= port <= 65535:
        return False
    return isinstance(key, str) and _KEY.match(key) is not None and (run is None or isinstance(run, str))


def proxy_keys(folder: str, run: str, targets: Sequence[str]) -> list[str]:
    """The keys of the proxies registered in `folder` that a connection named by any of `targets`
    (host:port, as the guard names one) reaches: at each one's own address, or at localhost with its
    port. Only those recording `run`, the agent's, or each session's own."""
    keys: list[str] = []
    try:
        if not _alone(os.lstat(folder), True):
            return keys
        names = os.listdir(folder)
    except OSError:
        return keys
    for name in names:
        m = _NAME.match(name)
        if not m:
            continue
        path = os.path.join(folder, name)
        try:
            if not _alone(os.lstat(path), False):
                continue
            with open(path, encoding="utf-8") as f:
                j = json.load(f)
        except (OSError, ValueError):
            continue  # unreadable, or gone meanwhile
        if not _registration(j, int(m.group(1))) or j["run"] not in (None, run):
            continue
        if any(t in ("%s:%s" % (j["host"], j["port"]), "localhost:%s" % j["port"]) for t in targets) and _alive(j["pid"]):
            keys.append(j["key"])
    return keys


def proof(connect: Callable[[tuple[str, int]], socket.socket], host: str, port: int, keys: Sequence[str]) -> str:
    """What answers at host:port, asked with a challenge made for this once over a connection `connect`
    opens (one the guard never checks): "proven" when it proves it holds one of `keys`, "nothing" when
    nothing listens there (the connection is refused, as the agent's will be), else "unproven"."""
    import hashlib
    import hmac

    challenge = os.urandom(16).hex()
    try:
        conn = connect((host, port))
    except ConnectionRefusedError:
        return "nothing"
    except OSError:
        return "unproven"
    data = b""
    try:
        conn.settimeout(PROOF_SECONDS)
        named = "[%s]" % host if ":" in host else host
        conn.sendall(("GET %s?challenge=%s HTTP/1.1\r\nHost: %s:%d\r\nConnection: close\r\n\r\n" % (PROOF_PATH, challenge, named, port)).encode("latin-1"))
        while len(data) <= _ANSWER_MAX:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
    except OSError:
        return "unproven"
    finally:
        conn.close()
    head, sep, body = data.partition(b"\r\n\r\n")
    if not sep or len(data) > _ANSWER_MAX or not re.match(rb"HTTP/1\.[01] 200 ", head):
        return "unproven"
    expected = [hmac.new(bytes.fromhex(key), challenge.encode("ascii"), hashlib.sha256).hexdigest().encode("ascii") for key in keys]
    return "proven" if any(hmac.compare_digest(body.strip(), e) for e in expected) else "unproven"
