"""Shadowlap network guard for Python agents.

Loaded by `shadowlap run` / `replay` / `test` through PYTHONPATH, so it needs no code change and
no dependency. It intercepts every outbound socket connection the agent process makes: the sidecar
is allowed, everything else is a side effect Shadowlap cannot replay, so it is reported
(SHADOWLAP_GUARD=warn) or refused (=block). SHADOWLAP_GUARD=off disables it;
SHADOWLAP_GUARD_ALLOW=host:port,host:port whitelists targets.

If the project has its own sitecustomize further down sys.path, it is loaded afterwards.
"""

import importlib.machinery
import importlib.util
import json
import os
import socket
import sys
import threading

_url = os.environ.get("SHADOWLAP_URL")
_mode = os.environ.get("SHADOWLAP_GUARD", "warn")

# In-process capture of model API calls a base URL can't redirect (Bedrock, Azure, Vertex, hardcoded URLs).
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import _shadowlap_capture  # noqa: F401
except Exception as _capture_error:  # never break the agent
    sys.stderr.write("[shadowlap] in-process capture is off: %s\n" % _capture_error)
finally:
    sys.path.pop(0)

# Recorded user input: input() and reads of sys.stdin become user_input calls a replay serves.
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import _shadowlap_input  # noqa: F401
except Exception as _input_error:  # never break the agent
    sys.stderr.write("[shadowlap] recorded user input is off: %s\n" % _input_error)
finally:
    sys.path.pop(0)

if _url and _mode != "off" and not getattr(socket, "_shadowlap_guard", False):
    socket._shadowlap_guard = True
    from urllib.parse import urlparse

    _u = urlparse(_url)
    _allowed = {"%s:%s" % (_u.hostname, _u.port or (443 if _u.scheme == "https" else 80))}
    if os.environ.get("SHADOWLAP_HTTP2_URL"):
        _h2 = urlparse(os.environ["SHADOWLAP_HTTP2_URL"])
        _allowed.add("%s:%s" % (_h2.hostname, _h2.port))
    for _item in os.environ.get("SHADOWLAP_GUARD_ALLOW", "").split(","):
        if _item.strip():
            _allowed.add(_item.strip())
    _seen = {}
    # Set on the thread that reports: the guard's own connections are never reported.
    _reporting = threading.local()

    def _report(key, action):
        def send():
            _reporting.active = True
            try:
                import urllib.request

                data = json.dumps({"target": key, "action": action, "runtime": "python"}).encode("utf-8")
                headers = {"content-type": "application/json"}
                run_id = os.environ.get("SHADOWLAP_RUN_ID")
                if run_id:
                    headers["x-shadowlap-run"] = run_id
                # Never through a proxy (HTTP_PROXY): the sidecar is on this machine's loopback.
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                opener.open(urllib.request.Request(_url + "/v1/guard", data=data, headers=headers, method="POST"), timeout=2).read()
            except Exception:
                pass

        threading.Thread(target=send, daemon=True).start()

    # Python connects to the address a name resolved to, so the guard remembers every name that
    # resolved to each address: the run then says which host it reached (api.stripe.com:443, not
    # an IP). Two hosts behind one address (a CDN, a shared load balancer) can't be told apart when
    # the socket connects, so an allowed name lets a connection through only while every name seen
    # for its address is allowed, and an address with several names is reported with all of them.
    _names = {}
    _orig_getaddrinfo = socket.getaddrinfo

    def _getaddrinfo(host, *args, **kwargs):
        infos = _orig_getaddrinfo(host, *args, **kwargs)
        try:
            name = host.decode("idna") if isinstance(host, bytes) else host
            if isinstance(name, str) and name:
                for info in infos:
                    if info[4][0] != name:
                        seen = _names.setdefault(info[4][0], [])
                        if name not in seen:
                            seen.append(name)
        except Exception:
            pass
        return infos

    socket.getaddrinfo = _getaddrinfo

    def _target(sock, address):
        if sock.family not in (socket.AF_INET, getattr(socket, "AF_INET6", None)):
            return None
        if not isinstance(address, tuple) or len(address) < 2:
            return None
        return "%s:%s" % (address[0], address[1])

    def _check(sock, address):
        if getattr(_reporting, "active", False):
            return
        key = _target(sock, address)
        if key is None or key in _allowed:
            return
        allow = key
        names = list(dict.fromkeys(_names.get(address[0], ())))
        named = ["%s:%s" % (name, address[1]) for name in names]
        if named and all(k in _allowed for k in named):
            return
        if len(named) == 1:
            key = allow = named[0]
        elif named:
            key = "%s (%s)" % (key, ", ".join(names))
        n = _seen.get(key, 0) + 1
        _seen[key] = n
        action = "blocked" if _mode == "block" else "warned"
        if n == 1:
            if _mode == "block":
                sys.stderr.write("[shadowlap] blocked an outbound connection to %s: it bypasses Shadowlap (SHADOWLAP_GUARD=block). Wrap the call as a tool, or allow it with SHADOWLAP_GUARD_ALLOW=%s.\n" % (key, allow))
            else:
                sys.stderr.write("[shadowlap] warning: outbound connection to %s bypasses Shadowlap and is not recorded; it will run again on every replay. Wrap the call as a tool.\n" % key)
        _report(key, action)
        if _mode == "block":
            raise OSError(1, "shadowlap: blocked outbound connection to %s (SHADOWLAP_GUARD=block)" % key)

    _orig_connect = socket.socket.connect
    _orig_connect_ex = socket.socket.connect_ex

    def _connect(self, address):
        _check(self, address)
        return _orig_connect(self, address)

    def _connect_ex(self, address):
        _check(self, address)
        return _orig_connect_ex(self, address)

    socket.socket.connect = _connect
    socket.socket.connect_ex = _connect_ex

# Chain to the project's own sitecustomize, if any.
_here = os.path.dirname(os.path.abspath(__file__))
_rest = [p for p in sys.path if os.path.abspath(p or ".") != _here]
_spec = importlib.machinery.PathFinder.find_spec("sitecustomize", _rest)
if _spec is not None and _spec.origin and os.path.abspath(_spec.origin) != os.path.abspath(__file__):
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
