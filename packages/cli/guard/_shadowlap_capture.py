"""Shadowlap in-process capture for Python agents, loaded by the sitecustomize next to it.

Most model clients read a base URL from the environment, and `shadowlap run` points those at the
sidecar. Bedrock clients sign each request for its host, Azure and Vertex clients often take their
endpoint or region in code, and any client may hardcode its base URL: for those, the request itself
is sent, unchanged and with every signed header, to the sidecar, naming the host it was going to in
`x-shadowlap-upstream`. The sidecar records it and forwards it to that host, or serves it from the
recording on replay.

Patched when first imported, so an agent that never loads them pays nothing: httpx and its fork
httpx2 (the Anthropic, OpenAI and Google clients, and many vector database clients), requests,
botocore (boto3, including bedrock-runtime), urllib3 for clients that use it directly (Pinecone,
Elasticsearch, OpenSearch), and aiohttp (LiteLLM's async transport, aiobotocore, and the
Anthropic and OpenAI SDKs' aiohttp backends).

A WebSocket for the sidecar opens as ``ws://``: a client whose base URL is the sidecar makes a
``wss://`` URL of it (the OpenAI SDK's Realtime client does), and the sidecar speaks no TLS. That
holds for websockets' clients, which the OpenAI SDK uses, and for aiohttp's.

A replay can fail a captured HTTP call with a timeout or an error (``--fail-at <call>=timeout``). A
request to such a host says it can take one (``x-shadowlap-failures: raise``), the sidecar answers by
naming the failure, and the call raises what the library raises for the real thing: httpx's
ReadTimeout or ReadError, urllib3's ReadTimeoutError or ProtocolError (which requests and botocore turn
into their own), aiohttp's ServerTimeoutError or ClientOSError, so the agent's error path runs.
"""

from __future__ import annotations

import contextvars
import errno
import importlib.abc
import importlib.machinery
import json
import os
import re
import sys
from urllib.parse import quote, unquote, urlsplit

# Typing's names for mypy alone (mypy.ini beside this file): at run time the module imports nothing it needn't.
TYPE_CHECKING = False
if TYPE_CHECKING:
    import types
    from collections.abc import Sequence
    from re import Pattern
    from typing import Any, Callable, Optional

_sidecar = os.environ.get("SHADOWLAP_URL")
_run = os.environ.get("SHADOWLAP_RUN_ID")
_config = os.environ.get("SHADOWLAP_CAPTURE")

_routes: list[tuple[Pattern[str], str]] = []
_hosts: dict[str, str] = {}
_http: list[tuple[Pattern[str], Optional[str]]] = []

# shadowlap.testing turns capture off between recorded tests, so a test without a recording reaches
# its hosts directly; under shadowlap run it is always on.
active = True

# The SDK's scope() variable, shared through sys so either side can create it first.
_found: Optional[contextvars.ContextVar[Optional[str]]] = getattr(sys, "_shadowlap_scope_var", None)
if _found is None:
    _found = contextvars.ContextVar("shadowlap_scope", default=None)
    setattr(sys, "_shadowlap_scope_var", _found)
_SCOPE: contextvars.ContextVar[Optional[str]] = _found


def _current_scope() -> Optional[str]:
    """The scope a call is made in: scope() in the SDK, else the one the process starts in, from
    SHADOWLAP_SCOPE (a sub-agent run as its own process), with the limits the sidecar accepts."""
    scoped = _SCOPE.get()
    if scoped:
        return scoped
    raw = (os.environ.get("SHADOWLAP_SCOPE") or "").strip()
    if not raw or len(raw) > 200 or any(ord(c) < 32 or ord(c) == 127 for c in raw):
        return None
    return raw


def _scope_header() -> Optional[str]:
    """The current scope (_current_scope) as x-shadowlap-scope carries it, or None: % and anything
    outside printable ASCII percent-encoded (UTF-8), as the SDK sends it, so a name of any language
    fits a header."""
    scope = _current_scope()
    if not scope:
        return None
    return "".join(c if " " <= c <= "~" and c != "%" else quote(c.encode("utf-8", "replace"), safe="") for c in scope)


def _to_sidecar(url: str) -> bool:
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return "%s:%s" % (parts.hostname or "", port) == _sidecar_key


def _provider_for(url: str) -> Optional[str]:
    parts = urlsplit(url)
    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)
    key = "%s:%s" % (host, port)
    if key == _sidecar_key:
        return None
    if key in _hosts:
        return _hosts[key]
    if parts.scheme == "https":
        for pattern, provider in _routes:
            if pattern.search(host):
                return provider
    if parts.scheme in ("http", "https"):
        # HTTP hosts declared under "http" in shadowlap.config.json, recorded as tools.
        for pattern, rule_port in _http:
            if pattern.search(host.lower()) and (rule_port is None or rule_port == str(port)):
                return "http"
    return None


def _rewrite(url: str) -> Optional[tuple[str, str, str]]:
    """(sidecar URL, upstream origin, provider), or None when the URL is not a host Shadowlap captures."""
    if not active:
        return None
    provider = _provider_for(url)
    if provider is None:
        return None
    parts = urlsplit(url)
    origin = "%s://%s" % (parts.scheme, parts.netloc)
    # Without a run id (a test worker), SHADOWLAP_URL names a slot and the sidecar resolves the run.
    run = "/r/%s" % quote(_run, safe="") if _run else ""
    target = "%s%s/%s%s" % (str(_sidecar).rstrip("/"), run, provider, parts.path or "/")
    if parts.query:
        target += "?" + parts.query
    return target, origin, provider


_FAILURES = "x-shadowlap-failures"

#: Headers this module adds for the sidecar alone. httpx and requests copy a request's headers onto a
#: redirect they follow, so a captured call the sidecar answered with a redirect to another host
#: would take them there: a request that goes neither to a captured host nor to the sidecar is sent
#: without them, as node-capture's redirects are.
_OWN_HEADERS = ("x-shadowlap-upstream", "x-shadowlap-scope", _FAILURES)


def _drop_own(headers: Any) -> None:
    """Removes, in place, the headers only the sidecar reads from a request's own header map (httpx's,
    requests', botocore's or a dict): whatever their case, every copy of each."""
    if headers is None:
        return
    try:
        names = [name for name in list(headers.keys()) if str(name).lower() in _OWN_HEADERS]
        for name in names:
            if name in headers:
                del headers[name]
    except Exception:  # never break the agent: the request goes as it was asked
        pass


def _injected(request_headers: Any, response_headers: Any) -> Optional[tuple[str, Optional[str]]]:
    """(kind, message) when the sidecar answered a request that asked for it with a failure --fail-at
    named (a timeout, or an error with the message given, if any), else None."""
    try:
        if request_headers is None or request_headers.get(_FAILURES) != "raise":
            return None
        kind = response_headers.get("x-shadowlap-injected")
        message = response_headers.get("x-shadowlap-injected-message")
    except Exception:
        return None
    if kind not in ("timeout", "error"):
        return None
    return kind, (unquote(message) if message else None)


def _reset(message: Optional[str]) -> ConnectionResetError:
    return ConnectionResetError(errno.ECONNRESET, message or os.strerror(errno.ECONNRESET))


def _patch_httpx(module: types.ModuleType) -> None:
    if getattr(module, "_shadowlap_capture", False):
        return
    setattr(module, "_shadowlap_capture", True)
    # The module's own classes, as it is imported: httpx, or its fork httpx2.
    httpx: Any = module

    def redirect(request: Any) -> None:
        scoped = _scope_header()
        rewritten = _rewrite(str(request.url))
        if rewritten is not None:
            target, origin, provider = rewritten
            request.headers["x-shadowlap-upstream"] = origin
            request.url = httpx.URL(target)
            if scoped:
                request.headers["x-shadowlap-scope"] = scoped
            if provider == "http":
                request.headers[_FAILURES] = "raise"
        elif _to_sidecar(str(request.url)):
            # A client already pointed at the sidecar by its base URL: only the scope needs adding.
            if scoped:
                request.headers["x-shadowlap-scope"] = scoped
        else:
            # Anywhere else, such as a redirect httpx follows to another host: nothing of the sidecar's goes.
            _drop_own(request.headers)

    def failure(request: Any, injected: tuple[str, Optional[str]]) -> Exception:
        kind, message = injected
        error: Exception = httpx.ReadTimeout(message or "timed out", request=request) if kind == "timeout" else httpx.ReadError(message or "Connection reset by peer", request=request)
        return error

    # A client behind a proxy picks its proxy's transport by the URL it asked for, before the request
    # is sent to the sidecar here. The sidecar is on this machine's loopback: a proxy would see the
    # call, its key and the session token in clear text, and can't reach it anyway. So a request for
    # the sidecar on a proxy's transport goes on a direct one instead.
    direct: dict[object, Any] = {}

    def proxied(transport: Any) -> bool:
        return type(getattr(transport, "_pool", None)).__name__ in ("HTTPProxy", "AsyncHTTPProxy", "SOCKSProxy", "AsyncSOCKSProxy")

    def direct_transport(cls: Callable[[], Any], key: object) -> Any:
        transport = direct.get(key)
        if transport is None:
            transport = direct[key] = cls()
        return transport

    sync_handle = httpx.HTTPTransport.handle_request

    def handle_request(self: Any, request: Any) -> Any:
        redirect(request)
        if proxied(self) and _to_sidecar(str(request.url)):
            self = direct_transport(httpx.HTTPTransport, "sync")
        response = sync_handle(self, request)
        injected = _injected(request.headers, response.headers)
        if injected is None:
            return response
        response.close()
        raise failure(request, injected)

    httpx.HTTPTransport.handle_request = handle_request

    async_handle = httpx.AsyncHTTPTransport.handle_async_request

    async def handle_async_request(self: Any, request: Any) -> Any:
        redirect(request)
        if proxied(self) and _to_sidecar(str(request.url)):
            # One per event loop: an async connection pool belongs to the loop it was made on.
            import asyncio

            self = direct_transport(httpx.AsyncHTTPTransport, id(asyncio.get_running_loop()))
        response = await async_handle(self, request)
        injected = _injected(request.headers, response.headers)
        if injected is None:
            return response
        await response.aclose()
        raise failure(request, injected)

    httpx.AsyncHTTPTransport.handle_async_request = handle_async_request


def _patch_botocore(module: types.ModuleType) -> None:
    session: Any = getattr(module, "URLLib3Session", None)
    if session is None or getattr(session, "_shadowlap_capture", False):
        return
    session._shadowlap_capture = True
    send = session.send

    def captured_send(self: Any, request: Any) -> Any:
        rewritten = _rewrite(request.url)
        if rewritten is not None:
            target, origin, provider = rewritten
            request.headers["x-shadowlap-upstream"] = origin
            request.url = target
            scoped = _scope_header()
            if scoped:
                request.headers["x-shadowlap-scope"] = scoped
            if provider == "http":
                # Raised by the urllib3 patch underneath, which botocore turns into its own error.
                request.headers[_FAILURES] = "raise"
        elif not _to_sidecar(request.url):
            _drop_own(request.headers)
        return send(self, request)

    session.send = captured_send


_sidecar_pool: Any = None


def _pool_to_sidecar(module: Any) -> Any:
    """One connection pool to the sidecar, shared by every captured urllib3 call in this process."""
    global _sidecar_pool
    if _sidecar_pool is None:
        _sidecar_pool = module.connection_from_url(_sidecar, maxsize=16)
    return _sidecar_pool


def _patch_urllib3(module: types.ModuleType) -> None:
    """Clients that drive urllib3 themselves. A pool is bound to one host, so a captured request is
    sent on the pool to the sidecar instead, with the path the sidecar expects. A failure --fail-at
    named is raised here as urllib3 raises the real one, for urllib3's own users and for requests and
    botocore, which turn it into theirs."""
    pool: Any = getattr(module, "HTTPConnectionPool", None)
    if pool is None or getattr(pool, "_shadowlap_capture", False):
        return
    pool._shadowlap_capture = True
    urlopen = pool.urlopen
    urllib3: Any = module

    def fail(conn: Any, url: str, headers: Any, response: Any) -> Any:
        injected = _injected(headers, response.headers)
        if injected is None:
            return response
        try:
            drain = getattr(response, "drain_conn", None)
            if drain is not None:
                drain()
            response.release_conn()
        except Exception:
            pass
        kind, message = injected
        if kind == "timeout":
            raise urllib3.ReadTimeoutError(conn, url, "Read timed out.")
        raise urllib3.ProtocolError("Connection aborted.", _reset(message))

    def captured_urlopen(self: Any, method: str, url: str, body: Any = None, headers: Any = None, *args: Any, **kwargs: Any) -> Any:
        if url.startswith("http://") or url.startswith("https://"):
            full = url
        else:
            host = self.host if ":" not in self.host or self.host.startswith("[") else "[%s]" % self.host
            full = "%s://%s%s%s" % (self.scheme, host, ":%s" % self.port if self.port else "", url)
        scoped = _scope_header()
        rewritten = _rewrite(full)
        if rewritten is None:
            if not _to_sidecar(full) and headers is not None and any(str(name).lower() in _OWN_HEADERS for name in headers):
                # Anywhere else, such as a redirect followed to another host: nothing of the sidecar's goes.
                headers = dict(headers)
                _drop_own(headers)
            # Already pointed at the sidecar (a base URL, or a request another patch rewrote): only the scope.
            if scoped and _to_sidecar(full):
                headers = dict(self.headers if headers is None else headers)
                headers["x-shadowlap-scope"] = scoped
            if _to_sidecar(full) and (getattr(self, "proxy", None) is not None or "_socks_options" in (getattr(self, "conn_kw", None) or {})):
                # A pool through a proxy (requests behind HTTP_PROXY): the sidecar is on this machine's
                # loopback, so the request goes to it directly, never through the proxy, which would
                # see it in clear text. What the proxy needed stays behind.
                headers = {k: v for k, v in (headers or {}).items() if k.lower() != "proxy-authorization"}
                parts = urlsplit(full)
                path = parts.path + ("?" + parts.query if parts.query else "")
                sidecar_pool = _pool_to_sidecar(module)
                return fail(sidecar_pool, path, headers, urlopen(sidecar_pool, method, path, body, headers, *args, **kwargs))
            return fail(self, url, headers, urlopen(self, method, url, body, headers, *args, **kwargs))
        target, origin, provider = rewritten
        headers = dict(self.headers if headers is None else headers)
        headers["x-shadowlap-upstream"] = origin
        if scoped:
            headers["x-shadowlap-scope"] = scoped
        if provider == "http":
            headers[_FAILURES] = "raise"
        parts = urlsplit(target)
        path = parts.path + ("?" + parts.query if parts.query else "")
        sidecar_pool = _pool_to_sidecar(module)
        return fail(sidecar_pool, path, headers, urlopen(sidecar_pool, method, path, body, headers, *args, **kwargs))

    pool.urlopen = captured_urlopen


def _patch_requests(module: types.ModuleType) -> None:
    adapter: Any = getattr(module, "HTTPAdapter", None)
    if adapter is None or getattr(adapter, "_shadowlap_capture", False):
        return
    adapter._shadowlap_capture = True
    send = adapter.send
    requests: Any = module

    def captured_send(self: Any, request: Any, *args: Any, **kwargs: Any) -> Any:
        rewritten = _rewrite(request.url)
        scoped = _scope_header()
        if rewritten is not None:
            target, origin, provider = rewritten
            request.headers["x-shadowlap-upstream"] = origin
            request.url = target
            if provider == "http":
                request.headers[_FAILURES] = "raise"
        if scoped and (rewritten is not None or _to_sidecar(request.url)):
            request.headers["x-shadowlap-scope"] = scoped
        if rewritten is None and not _to_sidecar(request.url):
            # Anywhere else, such as a redirect requests follows to another host: nothing of the sidecar's goes.
            _drop_own(request.headers)
        response = send(self, request, *args, **kwargs)
        # The urllib3 patch underneath raises first; this covers an adapter that does not use it.
        injected = _injected(request.headers, response.headers)
        if injected is None:
            return response
        response.close()
        kind, message = injected
        if kind == "timeout":
            raise requests.ReadTimeout("Read timed out.", request=request)
        raise requests.ConnectionError(_reset(message), request=request)

    adapter.send = captured_send


def _with_headers(headers: Any, extra: dict[str, str]) -> Any:
    """`headers` (a dict, a multidict, a list of pairs, or None) with `extra` set in a copy of them."""
    if headers is None:
        return dict(extra)
    if isinstance(headers, (list, tuple)):
        return list(headers) + list(extra.items())
    try:
        out = headers.copy()
    except AttributeError:
        out = dict(headers)
    for name, value in extra.items():
        out[name] = value
    return out


def _sidecar_ws(url: object) -> Optional[str]:
    """A ``wss://`` URL for the sidecar as ``ws://``, or None for any other."""
    text = str(url)
    if text[:6].lower() == "wss://" and _to_sidecar("https://" + text[6:]):
        return "ws://" + text[6:]
    return None


def _patch_aiohttp(module: types.ModuleType) -> None:
    """aiohttp: a request is redirected where aiohttp makes it (ClientRequest), so a session's base
    URL, its redirects and ws_connect all come through here, and a proxy it was given (trust_env and
    HTTP_PROXY) is left out for the sidecar, which is on this machine's loopback."""
    request: Any = getattr(module, "ClientRequest", None)
    if request is None or getattr(request, "_shadowlap_capture", False):
        return
    request._shadowlap_capture = True
    url_type = getattr(module, "URL", None)
    init = request.__init__

    def captured_init(self: Any, method: str, url: Any, *args: Any, **kwargs: Any) -> None:
        try:
            full = str(url)
            target: Optional[str] = None
            extra: dict[str, str] = {}
            rewritten = _rewrite(full)
            if rewritten is not None:
                target, origin, provider = rewritten
                extra["x-shadowlap-upstream"] = origin
                if provider == "http":
                    extra[_FAILURES] = "raise"
            else:
                target = _sidecar_ws(full)
            if target is not None or _to_sidecar(full):
                scoped = _scope_header()
                if scoped:
                    extra["x-shadowlap-scope"] = scoped
                if target is not None:
                    url = url_type(target, encoded=True) if url_type is not None and not isinstance(url, str) else target
                if extra:
                    kwargs["headers"] = _with_headers(kwargs.get("headers"), extra)
                for name in ("proxy", "proxy_auth", "proxy_headers"):
                    if kwargs.get(name) is not None:
                        kwargs[name] = None
        except Exception:  # never break the agent: the request goes as it was asked
            pass
        init(self, method, url, *args, **kwargs)

    request.__init__ = captured_init

    response: Any = getattr(module, "ClientResponse", None)
    if response is None or getattr(response, "_shadowlap_capture", False):
        return
    response._shadowlap_capture = True
    start = response.start

    async def captured_start(self: Any, connection: Any) -> Any:
        started = await start(self, connection)
        injected = _injected(self.request_info.headers, self.headers)
        if injected is None:
            return started
        self.close()
        from aiohttp import client_exceptions

        kind, message = injected
        if kind == "timeout":
            raise client_exceptions.ServerTimeoutError(message or "Timeout on reading data from socket")
        raise client_exceptions.ClientOSError(errno.ECONNRESET, message or os.strerror(errno.ECONNRESET))

    response.start = captured_start


def _patch_websockets(module: types.ModuleType) -> None:
    """websockets' clients, the OpenAI SDK's among them: a ``wss://`` URI for the sidecar connects as
    ``ws://``, without the TLS settings a ``ws://`` URI refuses."""
    connect: Any = getattr(module, "connect", None)
    if connect is None or getattr(connect, "_shadowlap_capture", False):
        return

    def plain(uri: Any, kwargs: dict[str, Any]) -> Any:
        target = _sidecar_ws(uri)
        if target is None:
            return uri
        kwargs.pop("ssl", None)
        kwargs.pop("server_hostname", None)
        return target

    if isinstance(connect, type):
        # The asyncio client's connect and the legacy Connect are classes.
        init = getattr(connect, "__init__")

        def captured_init(self: Any, uri: Any, *args: Any, **kwargs: Any) -> None:
            init(self, plain(uri, kwargs), *args, **kwargs)

        setattr(connect, "__init__", captured_init)
        setattr(connect, "_shadowlap_capture", True)
    else:

        def captured_connect(uri: Any, *args: Any, **kwargs: Any) -> Any:
            return connect(plain(uri, kwargs), *args, **kwargs)

        setattr(captured_connect, "_shadowlap_capture", True)
        setattr(module, "connect", captured_connect)


_PATCHES: dict[str, Callable[[types.ModuleType], None]] = {
    "httpx": _patch_httpx,
    "httpx2": _patch_httpx,
    "botocore.httpsession": _patch_botocore,
    "requests.adapters": _patch_requests,
    "urllib3.connectionpool": _patch_urllib3,
    "aiohttp.client_reqrep": _patch_aiohttp,
    "websockets.asyncio.client": _patch_websockets,
    "websockets.sync.client": _patch_websockets,
    "websockets.legacy.client": _patch_websockets,
}


class _Finder(importlib.abc.MetaPathFinder):
    """Patches a module right after it is imported, whoever imports it."""

    def find_spec(self, name: str, path: Optional[Sequence[str]], target: Optional[types.ModuleType] = None) -> Optional[importlib.machinery.ModuleSpec]:
        if name not in _PATCHES:
            return None
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is None or spec.loader is None:
            return spec
        loader = spec.loader
        exec_module = loader.exec_module

        def exec_and_patch(module: types.ModuleType) -> None:
            exec_module(module)
            try:
                _PATCHES[name](module)
            except Exception as err:  # never break the agent
                sys.stderr.write("[shadowlap] could not set up capture for %s: %s\n" % (name, err))

        setattr(loader, "exec_module", exec_and_patch)
        return spec


_sidecar_key: Optional[str]
if _sidecar and _config and _config != "off" and not getattr(sys, "_shadowlap_capture", False):
    setattr(sys, "_shadowlap_capture", True)
    _u = urlsplit(_sidecar)
    _sidecar_key = "%s:%s" % (_u.hostname, _u.port or (443 if _u.scheme == "https" else 80))
    try:
        _parsed = json.loads(_config)
        _routes = [(re.compile(source), provider) for source, provider in _parsed.get("routes", [])]
        _hosts = dict(_parsed.get("hosts", {}))
        _http = [(re.compile(source), port) for source, port in _parsed.get("http", [])]
        for _name, _patch in _PATCHES.items():
            if _name in sys.modules:
                _patch(sys.modules[_name])
        sys.meta_path.insert(0, _Finder())
    except Exception as _err:
        sys.stderr.write("[shadowlap] in-process capture is off: %s\n" % _err)
else:
    _sidecar_key = None
