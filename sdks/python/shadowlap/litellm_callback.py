"""Capture production model calls from a LiteLLM proxy, as a Shadowlap recording.

Shadowlap normally records by sitting in front of the agent itself, which suits a laptop and CI. In
production nobody re-points their agent at a dev tool — but plenty of teams already route model
traffic through LiteLLM, which is the same thing: a gateway in the request path that sees the real
bytes. This is a LiteLLM callback that writes what it sees in a form ``shadowlap import litellm``
reads.

Add it to the proxy's config, next to it on the path::

    litellm_settings:
      callbacks: shadowlap.litellm_callback.proxy_handler_instance

and set ``SHADOWLAP_CAPTURE_DIR`` to where the files should go. Then::

    shadowlap import litellm /path/to/capture/*.jsonl
    shadowlap replay <run> -- python agent.py

What is captured is the request **the agent sent to the proxy**, not the one the proxy sent to the
provider. That is the right one: replay matches what the agent's own code produces, and to the agent
the proxy *is* the provider.

Three things to know, all of them deliberate:

- **Streamed calls lose their chunking.** LiteLLM hands the callback an assembled response, so the
  original event boundaries are gone. The stream is re-serialized as a single SSE event carrying the
  whole message: the agent's streaming code still runs and parses it, but it sees one chunk instead
  of many, and per-token behaviour is not reproduced.
- **LiteLLM's own additions to the body are removed.** It writes `litellm_call_id` and friends into
  the inbound request before a callback sees it, and `litellm_call_id` is unique per request, so a
  recording that kept it would not match itself. A top-level ``metadata`` goes too: LiteLLM
  overwrites it, so an agent's own cannot be told apart. One case has no clean answer —
  ``stream_options`` is added to a streamed request that lacked it, and is also what an agent sends
  to ask for usage counts. It is kept, and `shadowlap calibrate` proposes the normalizer if it turns
  out to be why a replay forks.
- **Calls are grouped by a correlation id.** A gateway serves the whole fleet, so one capture file
  interleaves calls from unrelated agent runs. The agent should set ``x-shadowlap-run`` (or another
  of :data:`RUN_HEADERS`, or whatever ``SHADOWLAP_RUN_HEADER`` names) to a value that is the same
  for every call of one run; ``shadowlap import litellm`` makes a run per id. Calls with no id are
  imported together, which is only useful when one agent had the proxy to itself.
- **Nothing here is allowed to affect the proxy.** Every hook swallows its own errors: a capture
  that fails is a capture you do not have, never a request that failed.
"""

import json
import os
import time
from typing import Any, Dict

from litellm.integrations.custom_logger import CustomLogger

from ._capture import FORMAT, VERSION, _agent_body, _headers, _lock, _capture_path, _millis, _response_text, _run_key

class ShadowlapCapture(CustomLogger):  # type: ignore[misc]  # LiteLLM ships no types
    """Writes each completed model call as one line of JSON."""

    def _write(self, record: Dict[str, Any]) -> None:
        path = _capture_path()
        if not path:
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        line = json.dumps(record, default=str) + "\n"
        with _lock:
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(line)

    def _record(self, kwargs: Dict[str, Any], response: Any, start: Any, end: Any, failed: bool) -> None:
        params = kwargs.get("litellm_params") or {}
        request = params.get("proxy_server_request") or {}
        body = request.get("body")
        if not isinstance(body, dict):
            # Not a proxy call (a library call has no inbound request), so there is nothing whose
            # replay we could match: skip it rather than invent a request.
            return
        body = _agent_body(body)
        streamed = bool(body.get("stream"))
        text = None if failed else _response_text(response, streamed)
        started = _millis(request.get("arrival_time")) or _millis(start) or int(time.time() * 1000)
        finished = _millis(end)

        headers = _headers(request.get("headers"))
        run_key = _run_key(headers)
        record: Dict[str, Any] = {
            "format": FORMAT,
            "v": VERSION,
            "url": request.get("url"),
            "method": request.get("method") or "POST",
            "requestHeaders": headers,
            "requestBody": body,
            "status": 500 if failed else 200,
            "responseHeaders": {"content-type": "text/event-stream" if streamed else "application/json"},
            "responseBody": text if text is not None else json.dumps({"error": {"message": str(response)[:2000]}}),
            "startedAt": started,
        }
        if run_key:
            record["runKey"] = run_key
        if finished is not None and finished >= started:
            record["timeMs"] = finished - started
        self._write(record)

    async def async_log_success_event(self, kwargs: Dict[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:  # noqa: D102
        # The only hook that fires for both streamed and non-streamed calls, and it carries the
        # inbound request in litellm_params for both.
        try:
            self._record(kwargs, response_obj, start_time, end_time, failed=False)
        except Exception:
            pass

    async def async_log_failure_event(self, kwargs: Dict[str, Any], response_obj: Any, start_time: Any, end_time: Any) -> None:  # noqa: D102
        try:
            self._record(kwargs, response_obj, start_time, end_time, failed=True)
        except Exception:
            pass


proxy_handler_instance = ShadowlapCapture()
