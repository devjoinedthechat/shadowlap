"""An agent that reads a search service with each HTTP library it has (requests, urllib3, httpx) and
reports how each call ended: its status, or the class and message of the error its client raised."""

import json
import os

base = os.environ["SEARCH_URL"]


def body(q):
    return json.dumps({"q": q})


headers = {"content-type": "application/json"}
out = {}


def ended(name, call):
    try:
        out[name] = {"status": call()}
    except Exception as err:  # what the agent's error path would see
        out[name] = {"error": "%s.%s" % (type(err).__module__, type(err).__name__), "message": str(err)}


try:
    import requests

    ended("requests", lambda: requests.post(base + "/query", data=body("requests"), headers=headers, timeout=30).status_code)
except ImportError:
    pass

try:
    import urllib3

    ended("urllib3", lambda: urllib3.PoolManager(retries=False).request("POST", base + "/query", body=body("urllib3"), headers=headers).status)
except ImportError:
    pass

try:
    import httpx

    ended("httpx", lambda: httpx.post(base + "/query", content=body("httpx"), headers=headers, timeout=30).status_code)
except ImportError:
    pass

print(json.dumps(out))
