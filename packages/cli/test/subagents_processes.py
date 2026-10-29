"""Two sub-agents run as separate processes the orchestrator spawns with SHADOWLAP_SCOPE set. Each
starts with the same request and continues from its answer, through the first HTTP library this
Python has (httpx, requests or urllib3), at the base URL shadowlap run sets. ORDER=reverse swaps
which one asks first."""

import json
import os
import subprocess
import sys
import time


def create(messages):
    url = os.environ["ANTHROPIC_BASE_URL"].rstrip("/") + "/v1/messages"
    body = {"model": "claude-opus-5", "max_tokens": 16, "messages": messages}
    headers = {"content-type": "application/json", "x-api-key": "k", "anthropic-version": "2023-06-01"}
    try:
        import httpx

        response = httpx.post(url, json=body, headers=headers)
        response.raise_for_status()
        return response.json()["content"][0]["text"]
    except ImportError:
        pass
    try:
        import requests

        response = requests.post(url, json=body, headers=headers, timeout=60)
        response.raise_for_status()
        return response.json()["content"][0]["text"]
    except ImportError:
        pass
    import urllib3

    response = urllib3.PoolManager().request("POST", url, body=json.dumps(body).encode(), headers=headers)
    return json.loads(response.data)["content"][0]["text"]


def worker(name, wait):
    time.sleep(wait)
    plan = create([{"role": "user", "content": "Make a plan."}])
    done = create([{"role": "user", "content": "Make a plan."}, {"role": "assistant", "content": plan}, {"role": "user", "content": "Carry it out as %s." % name}])
    return "%s: %s / %s" % (name, plan, done)


if os.environ.get("WORKER"):
    sys.stdout.write(worker(os.environ["WORKER"], float(os.environ["WAIT"])))
else:
    a, b = (0.5, 0) if os.environ.get("ORDER") == "reverse" else (0, 0.5)
    children = [
        subprocess.Popen([sys.executable, __file__], env={**os.environ, "WORKER": name, "WAIT": str(wait), "SHADOWLAP_SCOPE": name}, stdout=subprocess.PIPE, text=True)
        for name, wait in (("alpha", a), ("beta", b))
    ]
    print(json.dumps([c.communicate()[0] for c in children]))
