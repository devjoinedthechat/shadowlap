"""Shadowlap network guard for Python agents.

Loaded by `shadowlap run` / `replay` / `test` through PYTHONPATH, so it needs no code change and
no dependency. It intercepts every outbound connection the agent process makes, and every UDP
datagram it sends: the sidecar is allowed, everything else is a side effect Shadowlap cannot
replay, so it is reported (SHADOWLAP_GUARD=warn) or refused (=block). SHADOWLAP_GUARD=off disables
it; SHADOWLAP_GUARD_ALLOW=host:port,host:port whitelists targets.

It sees what goes through Python's socket module, asyncio's event loops (the selector loop, and
the proactor loop that is Windows' default), and uvloop. A library that opens its sockets in C,
such as libpq under psycopg, mysqlclient or grpcio, is out of its sight. A name lookup through
getaddrinfo is no connection Python makes, and a DNS query to port 53 is left alone.

Once set up, the preload says so to the sidecar (POST /v1/hello), once per process: a run that made
calls with no hello from any process is one the guard never watched. If the project has its own
sitecustomize further down sys.path, it is loaded afterwards.
"""

from __future__ import annotations

import atexit
import contextlib
import errno
import importlib.abc
import importlib.machinery
import importlib.util
import json
import os
import socket
import sys
import threading
import time
from urllib.parse import urlparse

# Typing's names for mypy alone (mypy.ini beside this file): at run time the guard imports nothing it needn't.
TYPE_CHECKING = False
if TYPE_CHECKING:
    import types
    from collections.abc import Sequence
    from typing import Any, Callable, Optional

_url = os.environ.get("SHADOWLAP_URL")
_mode = os.environ.get("SHADOWLAP_GUARD", "warn")

# In-process capture of model API calls a base URL can't redirect (Bedrock, Azure, Vertex, hardcoded URLs).
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import _shadowlap_capture  # noqa: F401 -- loaded for what it patches
except Exception as _capture_error:  # never break the agent
    sys.stderr.write("[shadowlap] in-process capture is off: %s\n" % _capture_error)
finally:
    sys.path.pop(0)

# Recorded user input: input() and reads of sys.stdin become user_input calls a replay serves.
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import _shadowlap_input  # noqa: F401 -- loaded for what it patches
except Exception as _input_error:  # never break the agent
    sys.stderr.write("[shadowlap] recorded user input is off: %s\n" % _input_error)
finally:
    sys.path.pop(0)

# Set on the thread that talks to the sidecar: the guard never reports the preload's own connections.
_reporting = threading.local()
# Posts on their way to the sidecar, which the agent waits for when it exits (_flush).
_sending: set[threading.Thread] = set()


def _post(path: str, payload: dict[str, Any]) -> None:
    """Posts `payload` as JSON to the sidecar, on a thread of its own: straight to this machine's
    loopback, never through a proxy (HTTP_PROXY), and over a plain socket, so no HTTP library is
    imported for it, nor a TLS context made for nothing (as urllib's opener makes one, reading the
    system's certificates, slowly on Windows)."""

    def send() -> None:
        _reporting.active = True
        try:
            target = urlparse(str(_url))
            body = json.dumps(payload).encode("utf-8")
            head = ["POST %s%s HTTP/1.1" % (target.path.rstrip("/"), path), "Host: %s" % target.netloc, "Content-Type: application/json", "Content-Length: %d" % len(body), "Connection: close"]
            run_id = os.environ.get("SHADOWLAP_RUN_ID")
            if run_id:
                head.append("x-shadowlap-run: %s" % run_id)
            conn = socket.create_connection((target.hostname, target.port or 80), timeout=2)
            try:
                conn.sendall(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + body)
                # Read to the end of the answer, which the sidecar closes, so it is never cut off.
                while conn.recv(4096):
                    pass
            finally:
                conn.close()
        except Exception:
            pass
        finally:
            _sending.discard(threading.current_thread())

    thread = threading.Thread(target=send, name="shadowlap-preload", daemon=True)
    _sending.add(thread)
    try:
        thread.start()
    except RuntimeError:  # no new thread while the interpreter shuts down
        _sending.discard(thread)


def _flush() -> None:
    # The run lists what bypassed Shadowlap from these reports, and counts the preloads that loaded:
    # one still on its way when the agent exits would be left out, so the agent waits for them,
    # 2 seconds at most in all.
    deadline = time.monotonic() + 2
    for thread in list(_sending):
        # One not started yet has nothing to wait for.
        with contextlib.suppress(RuntimeError):
            thread.join(max(0.0, deadline - time.monotonic()))


if _url:
    atexit.register(_flush)

if _url and _mode != "off" and not getattr(socket, "_shadowlap_guard", False):
    setattr(socket, "_shadowlap_guard", True)

    _u = urlparse(_url)
    _allowed = {"%s:%s" % (_u.hostname, _u.port or (443 if _u.scheme == "https" else 80))}
    if os.environ.get("SHADOWLAP_HTTP2_URL"):
        _h2 = urlparse(os.environ["SHADOWLAP_HTTP2_URL"])
        _allowed.add("%s:%s" % (_h2.hostname, _h2.port))
    for _item in os.environ.get("SHADOWLAP_GUARD_ALLOW", "").split(","):
        if _item.strip():
            _allowed.add(_item.strip())
    _seen: dict[str, int] = {}

    def _report(key: str, action: str) -> None:
        _post("/v1/guard", {"target": key, "action": action, "runtime": "python"})

    # Python connects to the address a name resolved to, so the guard remembers every name that
    # resolved to each address: the run then says which host it reached (api.stripe.com:443, not
    # an IP). Two hosts behind one address (a CDN, a shared load balancer) can't be told apart when
    # the socket connects, so an allowed name lets a connection through only while every name seen
    # for its address is allowed, and an address with several names is reported with all of them.
    _names: dict[str, list[str]] = {}
    _orig_getaddrinfo = socket.getaddrinfo

    def _getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
        infos = _orig_getaddrinfo(host, *args, **kwargs)
        try:
            name = host.decode("idna") if isinstance(host, bytes) else host
            if isinstance(name, str) and name:
                for info in infos:
                    if info[4][0] != name:
                        seen = _names.setdefault(str(info[4][0]), [])
                        if name not in seen:
                            seen.append(name)
        except Exception:
            pass
        return infos

    setattr(socket, "getaddrinfo", _getaddrinfo)

    def _bypass(host: Any, port: Any, datagram: bool = False) -> None:
        """Reports a connection to host:port, or a datagram sent there, that bypasses Shadowlap, and
        refuses it under block. `host` is an address or, where a loop resolves the name itself
        (uvloop), the name the agent gave."""
        if getattr(_reporting, "active", False):
            return
        # A DNS query reads nothing of the agent's and changes nothing.
        if datagram and str(port) == "53":
            return
        key = "%s:%s" % (host, port)
        if key in _allowed:
            return
        allow = key
        names = list(dict.fromkeys(_names.get(host, ())))
        named = ["%s:%s" % (name, port) for name in names]
        if named and all(k in _allowed for k in named):
            return
        if len(named) == 1:
            key = allow = named[0]
        elif named:
            key = "%s (%s)" % (key, ", ".join(names))
        # The run lists a UDP target apart from a TCP one on the same port.
        reported = "udp://" + key if datagram else key
        n = _seen.get(reported, 0) + 1
        _seen[reported] = n
        action = "blocked" if _mode == "block" else "warned"
        what = "a UDP datagram" if datagram else "an outbound connection"
        if n == 1:
            if _mode == "block":
                sys.stderr.write("[shadowlap] blocked %s to %s: it bypasses Shadowlap (SHADOWLAP_GUARD=block). Wrap the call as a tool, or allow it with SHADOWLAP_GUARD_ALLOW=%s.\n" % (what, key, allow))
            else:
                sys.stderr.write("[shadowlap] warning: %s to %s bypasses Shadowlap and is not recorded; it will run again on every replay. Wrap the call as a tool.\n" % (what, key))
        # A client that sends a datagram per metric is reported once per target, not per datagram.
        if not datagram or n == 1:
            _report(reported, action)
        if _mode == "block":
            raise OSError(errno.EPERM, "shadowlap: blocked %s to %s (SHADOWLAP_GUARD=block)" % (what, key))

    def _datagram(sock: socket.socket) -> bool:
        try:
            return sock.type == socket.SOCK_DGRAM
        except Exception:
            return False

    def _check(sock: socket.socket, address: Any) -> None:
        try:
            family = sock.family
        except Exception:
            return
        if family not in (socket.AF_INET, getattr(socket, "AF_INET6", None)):
            return  # a unix socket or a pipe: local IPC
        if not isinstance(address, tuple) or len(address) < 2:
            return
        _bypass(address[0], address[1], _datagram(sock))

    # ---- the socket module: blocking clients, and asyncio's selector loop, which calls these ----
    _orig_connect = socket.socket.connect
    _orig_connect_ex = socket.socket.connect_ex
    _orig_sendto = socket.socket.sendto
    _orig_sendmsg = getattr(socket.socket, "sendmsg", None)

    def _connect(self: socket.socket, address: Any) -> None:
        _check(self, address)
        return _orig_connect(self, address)

    def _connect_ex(self: socket.socket, address: Any) -> int:
        _check(self, address)
        return _orig_connect_ex(self, address)

    def _sendto(self: socket.socket, data: Any, *args: Any) -> int:
        # sendto(data, address) or sendto(data, flags, address)
        if args:
            _check(self, args[-1])
        return _orig_sendto(self, data, *args)

    setattr(socket.socket, "connect", _connect)
    setattr(socket.socket, "connect_ex", _connect_ex)
    setattr(socket.socket, "sendto", _sendto)
    if _orig_sendmsg is not None:
        _sendmsg_through: Callable[..., int] = _orig_sendmsg

        def _sendmsg(self: socket.socket, buffers: Any, *args: Any) -> int:
            # sendmsg(buffers[, ancdata[, flags[, address]]])
            if len(args) >= 3 and args[2] is not None:
                _check(self, args[2])
            return _sendmsg_through(self, buffers, *args)

        setattr(socket.socket, "sendmsg", _sendmsg)

    # ---- event loops that open connections without the socket module's methods ----

    def _patch_proactor(module: types.ModuleType) -> None:
        """asyncio's proactor loop, Windows' default: it connects and sends through overlapped I/O."""
        loop = getattr(module, "BaseProactorEventLoop", None)
        if loop is None or getattr(loop, "_shadowlap_guard", False):
            return
        setattr(loop, "_shadowlap_guard", True)
        sock_connect = loop.sock_connect

        async def guarded_sock_connect(self: Any, sock: socket.socket, address: Any) -> Any:
            _check(sock, address)
            return await sock_connect(self, sock, address)

        setattr(loop, "sock_connect", guarded_sock_connect)
        sock_sendto = getattr(loop, "sock_sendto", None)
        if sock_sendto is not None:

            async def guarded_sock_sendto(self: Any, sock: socket.socket, data: Any, address: Any) -> Any:
                _check(sock, address)
                return await sock_sendto(self, sock, data, address)

            setattr(loop, "sock_sendto", guarded_sock_sendto)
        transport = getattr(module, "_ProactorDatagramTransport", None)
        if transport is not None:
            sendto = transport.sendto

            def guarded_sendto(self: Any, data: Any, addr: Any = None) -> Any:
                if addr is not None:
                    _check(self._sock, addr)
                return sendto(self, data, addr)

            setattr(transport, "sendto", guarded_sendto)

    def _patch_uvloop(module: types.ModuleType) -> None:  # noqa: C901  (held to its ceiling in lint-caps.json)
        """uvloop connects, resolves and sends in libuv, out of the socket module's sight."""
        loop = getattr(module, "Loop", None)
        if loop is None or getattr(loop, "_shadowlap_guard", False):
            return
        setattr(loop, "_shadowlap_guard", True)
        import asyncio

        sock_connect = loop.sock_connect
        create_connection = loop.create_connection
        create_datagram_endpoint = loop.create_datagram_endpoint
        sock_sendto = getattr(loop, "sock_sendto", None)

        async def guarded_sock_connect(self: Any, sock: socket.socket, address: Any) -> Any:
            _check(sock, address)
            return await sock_connect(self, sock, address)

        async def guarded_create_connection(self: Any, protocol_factory: Any, host: Any = None, port: Any = None, *args: Any, **kwargs: Any) -> Any:
            if host is not None and port is not None and kwargs.get("sock") is None:
                _bypass(host, port)
            return await create_connection(self, protocol_factory, host, port, *args, **kwargs)

        class GuardedTransport(asyncio.DatagramTransport):
            """A datagram transport whose sends to an address are checked, as a socket's sendto is."""

            def __init__(self, inner: Any) -> None:
                super().__init__()
                self._inner = inner

            def sendto(self, data: Any, addr: Any = None) -> None:
                if addr is not None and isinstance(addr, tuple) and len(addr) >= 2:
                    try:
                        _bypass(addr[0], addr[1], True)
                    except OSError as exc:
                        # As a loop's datagram transport reports a failed send: to its protocol.
                        self._inner.get_protocol().error_received(exc)
                        return
                self._inner.sendto(data, addr)

            def __getattr__(self, name: str) -> Any:
                inner = self.__dict__.get("_inner")
                if inner is None:
                    raise AttributeError(name)
                return getattr(inner, name)

            def get_extra_info(self, name: str, default: Any = None) -> Any:
                return self._inner.get_extra_info(name, default)

            def close(self) -> None:
                self._inner.close()

            def is_closing(self) -> bool:
                return bool(self._inner.is_closing())

            def abort(self) -> None:
                self._inner.abort()

            def get_protocol(self) -> Any:
                return self._inner.get_protocol()

            def set_protocol(self, protocol: Any) -> None:
                self._inner.set_protocol(protocol)

        class GuardedProtocol(asyncio.DatagramProtocol):
            def __init__(self, inner: Any) -> None:
                self.inner = inner
                self.transport: Optional[GuardedTransport] = None

            def connection_made(self, transport: Any) -> None:
                self.transport = GuardedTransport(transport)
                self.inner.connection_made(self.transport)

            def datagram_received(self, data: bytes, addr: Any) -> None:
                self.inner.datagram_received(data, addr)

            def error_received(self, exc: Exception) -> None:
                self.inner.error_received(exc)

            def connection_lost(self, exc: Optional[Exception]) -> None:
                self.inner.connection_lost(exc)

            def pause_writing(self) -> None:
                self.inner.pause_writing()

            def resume_writing(self) -> None:
                self.inner.resume_writing()

        async def guarded_create_datagram_endpoint(self: Any, protocol_factory: Callable[[], Any], local_addr: Any = None, remote_addr: Any = None, **kwargs: Any) -> Any:
            if isinstance(remote_addr, tuple) and len(remote_addr) >= 2:
                _bypass(remote_addr[0], remote_addr[1], True)
            guarded: list[GuardedProtocol] = []

            def factory() -> GuardedProtocol:
                guarded.append(GuardedProtocol(protocol_factory()))
                return guarded[-1]

            transport, _ = await create_datagram_endpoint(self, factory, local_addr, remote_addr, **kwargs)
            return guarded[0].transport or GuardedTransport(transport), guarded[0].inner

        setattr(loop, "sock_connect", guarded_sock_connect)
        setattr(loop, "create_connection", guarded_create_connection)
        setattr(loop, "create_datagram_endpoint", guarded_create_datagram_endpoint)
        if sock_sendto is not None:

            async def guarded_sock_sendto(self: Any, sock: socket.socket, data: Any, address: Any) -> Any:
                _check(sock, address)
                return await sock_sendto(self, sock, data, address)

            setattr(loop, "sock_sendto", guarded_sock_sendto)

    _LOOPS: dict[str, Callable[[types.ModuleType], None]] = {"asyncio.proactor_events": _patch_proactor, "uvloop": _patch_uvloop}

    class _LoopFinder(importlib.abc.MetaPathFinder):
        """Patches an event loop's module right after it is imported, whoever imports it: an agent
        that never imports one pays nothing."""

        def find_spec(self, name: str, path: Optional[Sequence[str]], target: Optional[types.ModuleType] = None) -> Optional[importlib.machinery.ModuleSpec]:
            if name not in _LOOPS:
                return None
            spec = importlib.machinery.PathFinder.find_spec(name, path)
            if spec is None or spec.loader is None or not hasattr(spec.loader, "exec_module"):
                return spec
            exec_module = spec.loader.exec_module

            def exec_and_patch(module: types.ModuleType) -> None:
                exec_module(module)
                try:
                    _LOOPS[name](module)
                except Exception as err:  # never break the agent
                    sys.stderr.write("[shadowlap] could not guard %s: %s\n" % (name, err))

            setattr(spec.loader, "exec_module", exec_and_patch)
            return spec

    for _name, _patch in _LOOPS.items():
        if _name in sys.modules:
            _patch(sys.modules[_name])
    sys.meta_path.insert(0, _LoopFinder())

# Says it loaded, with what it set up: a run whose processes all stayed silent was never watched.
if _url and not getattr(sys, "_shadowlap_hello", False):
    setattr(sys, "_shadowlap_hello", True)
    _post(
        "/v1/hello",
        {
            "runtime": "python",
            "runtimeVersion": "%d.%d.%d" % tuple(sys.version_info[:3]),
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "guard": _mode if getattr(socket, "_shadowlap_guard", False) else "off",
            "capture": bool(getattr(sys, "_shadowlap_capture", False)),
        },
    )

# Chain to the project's own sitecustomize, if any.
_here = os.path.dirname(os.path.abspath(__file__))
_rest = [p for p in sys.path if os.path.abspath(p or ".") != _here]
_spec = importlib.machinery.PathFinder.find_spec("sitecustomize", _rest)
if _spec is not None and _spec.loader is not None and _spec.origin and os.path.abspath(_spec.origin) != os.path.abspath(__file__):
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
