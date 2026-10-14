"""The pure part of capturing model calls from a gateway: what to keep, and in what shape.

Separated from :mod:`shadowlap.litellm_callback` so that the fiddly decisions — which fields a
gateway added, how a streamed response is re-serialized, which headers must never reach disk — are
testable without LiteLLM installed. The callback module is the thin binding to LiteLLM's hooks.
"""

import json
import os
import threading
import time
from typing import Any, Dict, Optional

FORMAT = "shadowlap-capture"
VERSION = 1

#: Never written to disk, even though the proxy has them.
CREDENTIAL_HEADERS = frozenset(
    {"authorization", "x-api-key", "api-key", "cookie", "set-cookie", "proxy-authorization", "x-goog-api-key", "x-amz-security-token"}
)

#: LiteLLM writes its own bookkeeping into the inbound body before a callback sees it. These are
#: identifiable because LiteLLM namespaces them, and they must go: `litellm_call_id` alone is unique
#: per request, so a recording that kept it would not even match itself.
INJECTED_BODY_PREFIXES = ("litellm_", "_litellm_")
#: Overwritten by LiteLLM with its own budget and key bookkeeping, so an agent's own `metadata`
#: cannot be told apart from it and is lost either way.
INJECTED_BODY_KEYS = ("metadata",)


def _agent_body(body: Dict[str, Any]) -> Dict[str, Any]:
    """The inbound body with LiteLLM's own additions removed.

    What is left is what the agent sent, with one exception this cannot resolve: LiteLLM adds
    `stream_options` to a streamed request that did not carry it, and an agent that asks for usage
    counts sends exactly the same field. Keeping it is right for that agent and wrong for the other,
    and the capture holds nothing that tells them apart. It is kept, because the field changes the
    response, and `shadowlap calibrate` proposes the normalizer when it is the reason a replay forks.
    """
    return {
        k: v
        for k, v in body.items()
        if k not in INJECTED_BODY_KEYS and not any(k.startswith(prefix) for prefix in INJECTED_BODY_PREFIXES)
    }

#: Headers, in order, that a correlation id is looked for in. A gateway serves every request the
#: agent's whole fleet makes, so a capture file interleaves calls from unrelated runs: without an id
#: to group them by, importing it produces one run holding several conversations at once. The agent
#: sets one of these and its own calls stay together. `SHADOWLAP_RUN_HEADER` names another.
RUN_HEADERS = ("x-shadowlap-run", "x-request-id", "x-correlation-id", "x-trace-id")

_lock = threading.Lock()


def _run_key(headers: Dict[str, str]) -> Optional[str]:
    names = ([os.environ["SHADOWLAP_RUN_HEADER"].lower()] if os.environ.get("SHADOWLAP_RUN_HEADER") else []) + list(RUN_HEADERS)
    for name in names:
        value = (headers.get(name) or "").strip()
        # Kept short and printable: it becomes a label on the run it groups.
        if value and len(value) <= 200 and all(ord(c) >= 32 and ord(c) != 127 for c in value):
            return value
    return None


def _capture_path() -> Optional[str]:
    directory = os.environ.get("SHADOWLAP_CAPTURE_DIR")
    if not directory:
        return None
    # One file per process, so several workers never interleave a line.
    return os.path.join(directory, "shadowlap-%d.jsonl" % os.getpid())


def _headers(raw: Any) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not isinstance(raw, dict):
        return out
    for name, value in raw.items():
        key = str(name).lower()
        if key in CREDENTIAL_HEADERS:
            continue
        out[key] = str(value)
    return out


def _millis(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value * 1000) if value < 1e11 else int(value)
    epoch = getattr(value, "timestamp", None)
    return int(epoch() * 1000) if callable(epoch) else None


def _as_sse(body: str) -> str:
    """One event carrying the whole message, then the terminator the SDKs expect."""
    return "data: %s\n\ndata: [DONE]\n\n" % body


def _response_text(response: Any, streamed: bool) -> Optional[str]:
    payload = response.model_dump() if hasattr(response, "model_dump") else response
    if not isinstance(payload, dict):
        return None
    if not streamed:
        return json.dumps(payload)
    # Re-shape the assembled response into the one chunk a streaming client can read.
    chunk = dict(payload)
    chunk["object"] = "chat.completion.chunk"
    for choice in chunk.get("choices") or []:
        if isinstance(choice, dict) and "message" in choice:
            choice["delta"] = choice.pop("message")
    return _as_sse(json.dumps(chunk))
