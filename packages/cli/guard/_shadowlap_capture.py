"""Shadowlap in-process capture for Python agents, loaded by the sitecustomize next to it.

Most model clients read a base URL from the environment, and `shadowlap run` points those at the
sidecar. Bedrock clients sign each request for its host, Azure and Vertex clients often take their
endpoint or region in code, and any client may hardcode its base URL: for those, the request itself
is sent, unchanged and with every signed header, to the sidecar, naming the host it was going to in
`x-shadowlap-upstream`. The sidecar records it and forwards it to that host, or serves it from the
recording on replay.

Patched when first imported, so an agent that never loads them pays nothing: httpx and its fork
httpx2 (the Anthropic, OpenAI and Google clients, and many vector database clients), requests,
botocore (boto3, including bedrock-runtime), and urllib3 for clients that use it directly (Pinecone,
Elasticsearch, OpenSearch).
"""

import contextvars
import importlib.abc
import importlib.machinery
import json
import os
import re
import sys
from urllib.parse import quote, urlsplit

_sidecar = os.environ.get("SHADOWLAP_URL")
_run = os.environ.get("SHADOWLAP_RUN_ID")
_config = os.environ.get("SHADOWLAP_CAPTURE")

_routes = []
_hosts = {}
_http = []

# The SDK's scope() variable, shared through sys so either side can create it first.
_SCOPE = getattr(sys, "_shadowlap_scope_var", None)
if _SCOPE is None:
    _SCOPE = contextvars.ContextVar("shadowlap_scope", default=None)
    sys._shadowlap_scope_var = _SCOPE


def _to_sidecar(url):
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return "%s:%s" % (parts.hostname or "", port) == _sidecar_key


def _provider_for(url):
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


def _rewrite(url):
    """(sidecar URL, upstream origin), or None when the URL is not a model API Shadowlap captures."""
    provider = _provider_for(url)
    if provider is None:
        return None
    parts = urlsplit(url)
    origin = "%s://%s" % (parts.scheme, parts.netloc)
    # Without a run id (a test worker), SHADOWLAP_URL names a slot and the sidecar resolves the run.
    run = "/r/%s" % quote(_run, safe="") if _run else ""
    target = "%s%s/%s%s" % (_sidecar.rstrip("/"), run, provider, parts.path or "/")
    if parts.query:
        target += "?" + parts.query
    return target, origin


def _patch_httpx(module):
    if getattr(module, "_shadowlap_capture", False):
        return
    module._shadowlap_capture = True

    def redirect(request):
        scoped = _SCOPE.get()
        rewritten = _rewrite(str(request.url))
        if rewritten is not None:
            target, origin = rewritten
            request.headers["x-shadowlap-upstream"] = origin
            request.url = module.URL(target)
            if scoped:
                request.headers["x-shadowlap-scope"] = scoped
        elif scoped and _to_sidecar(str(request.url)):
            # A client already pointed at the sidecar by its base URL: only the scope needs adding.
            request.headers["x-shadowlap-scope"] = scoped

    sync_handle = module.HTTPTransport.handle_request

    def handle_request(self, request):
        redirect(request)
        return sync_handle(self, request)

    module.HTTPTransport.handle_request = handle_request

    async_handle = module.AsyncHTTPTransport.handle_async_request

    async def handle_async_request(self, request):
        redirect(request)
        return await async_handle(self, request)

    module.AsyncHTTPTransport.handle_async_request = handle_async_request


def _patch_botocore(module):
    session = getattr(module, "URLLib3Session", None)
    if session is None or getattr(session, "_shadowlap_capture", False):
        return
    session._shadowlap_capture = True
    send = session.send

    def captured_send(self, request):
        rewritten = _rewrite(request.url)
        if rewritten is not None:
            target, origin = rewritten
            request.headers["x-shadowlap-upstream"] = origin
            request.url = target
            if _SCOPE.get():
                request.headers["x-shadowlap-scope"] = _SCOPE.get()
        return send(self, request)

    session.send = captured_send


_sidecar_pool = None


def _pool_to_sidecar(module):
    """One connection pool to the sidecar, shared by every captured urllib3 call in this process."""
    global _sidecar_pool
    if _sidecar_pool is None:
        _sidecar_pool = module.connection_from_url(_sidecar, maxsize=16)
    return _sidecar_pool


def _patch_urllib3(module):
    """Clients that drive urllib3 themselves. A pool is bound to one host, so a captured request is
    sent on the pool to the sidecar instead, with the path the sidecar expects."""
    pool = getattr(module, "HTTPConnectionPool", None)
    if pool is None or getattr(pool, "_shadowlap_capture", False):
        return
    pool._shadowlap_capture = True
    urlopen = pool.urlopen

    def captured_urlopen(self, method, url, body=None, headers=None, *args, **kwargs):
        if url.startswith("http://") or url.startswith("https://"):
            full = url
        else:
            host = self.host if ":" not in self.host or self.host.startswith("[") else "[%s]" % self.host
            full = "%s://%s%s%s" % (self.scheme, host, ":%s" % self.port if self.port else "", url)
        scoped = _SCOPE.get()
        rewritten = _rewrite(full)
        if rewritten is None:
            # Already pointed at the sidecar (a base URL, or a request another patch rewrote): only the scope.
            if scoped and _to_sidecar(full):
                headers = dict(self.headers if headers is None else headers)
                headers["x-shadowlap-scope"] = scoped
            return urlopen(self, method, url, body, headers, *args, **kwargs)
        target, origin = rewritten
        headers = dict(self.headers if headers is None else headers)
        headers["x-shadowlap-upstream"] = origin
        if scoped:
            headers["x-shadowlap-scope"] = scoped
        parts = urlsplit(target)
        path = parts.path + ("?" + parts.query if parts.query else "")
        return urlopen(_pool_to_sidecar(module), method, path, body, headers, *args, **kwargs)

    pool.urlopen = captured_urlopen


def _patch_requests(module):
    adapter = getattr(module, "HTTPAdapter", None)
    if adapter is None or getattr(adapter, "_shadowlap_capture", False):
        return
    adapter._shadowlap_capture = True
    send = adapter.send

    def captured_send(self, request, *args, **kwargs):
        rewritten = _rewrite(request.url)
        scoped = _SCOPE.get()
        if rewritten is not None:
            target, origin = rewritten
            request.headers["x-shadowlap-upstream"] = origin
            request.url = target
        if scoped and (rewritten is not None or _to_sidecar(request.url)):
            request.headers["x-shadowlap-scope"] = scoped
        return send(self, request, *args, **kwargs)

    adapter.send = captured_send


_PATCHES = {
    "httpx": _patch_httpx,
    "httpx2": _patch_httpx,
    "botocore.httpsession": _patch_botocore,
    "requests.adapters": _patch_requests,
    "urllib3.connectionpool": _patch_urllib3,
}


class _Finder(importlib.abc.MetaPathFinder):
    """Patches a module right after it is imported, whoever imports it."""

    def find_spec(self, name, path, target=None):
        if name not in _PATCHES:
            return None
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is None or spec.loader is None:
            return spec
        loader = spec.loader
        exec_module = loader.exec_module

        def exec_and_patch(module):
            exec_module(module)
            try:
                _PATCHES[name](module)
            except Exception as err:  # never break the agent
                sys.stderr.write("[shadowlap] could not set up capture for %s: %s\n" % (name, err))

        loader.exec_module = exec_and_patch
        return spec


if _sidecar and _config and _config != "off" and not getattr(sys, "_shadowlap_capture", False):
    sys._shadowlap_capture = True
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
