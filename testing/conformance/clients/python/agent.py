"""The Python SDK as a client under test.

One step per invocation, named by argv[1]; the result is one JSON object on stdout.
See ../../README.md for the contract a new client implements.
"""
import json
import sys

import shadowlap

step = sys.argv[1] if len(sys.argv) > 1 else ""
state = {"impl_runs": 0, "branch": None}


def out(obj):
    print(json.dumps(obj))


@shadowlap.tool(effect="read")
def echo(n):
    state["impl_runs"] += 1
    return {"got": n}


@shadowlap.tool(effect="read")
def boom():
    state["impl_runs"] += 1
    raise RuntimeError("boom")


@shadowlap.tool(effect="pure")
def pick():
    state["impl_runs"] += 1
    # Recorded: each branch produces its own value. Replayed: this never runs.
    return state["branch"]


@shadowlap.tool(effect="pure")
def ping():
    return "pong"


@shadowlap.tool(effect="write", on_fork=lambda **_: "stub")
def send(to):
    state["impl_runs"] += 1
    return "sent"


def branch(name):
    state["branch"] = name
    return pick()


if step == "live-ok":
    out({"result": echo(n=1), "implRuns": state["impl_runs"], "active": shadowlap.is_active()})

elif step == "live-error":
    try:
        boom()
        out({"caught": None, "implRuns": state["impl_runs"]})
    except BaseException as err:
        out({
            "caught": {
                "name": getattr(err, "name", type(err).__name__),
                "message": str(err),
                "replayed": isinstance(err, shadowlap.ReplayedError),
                "text": str(err),
                "repr": repr(err),
            },
            "implRuns": state["impl_runs"],
        })

elif step == "unserializable":

    @shadowlap.tool(name="weird", effect="read")
    def weird():
        state["impl_runs"] += 1
        return object()  # not JSON

    try:
        weird()
        out({"raised": False, "implRuns": state["impl_runs"]})
    except BaseException:
        out({"raised": True, "implRuns": state["impl_runs"]})

elif step == "non-finite":

    @shadowlap.tool(name="stats", effect="read")
    def stats():
        state["impl_runs"] += 1
        return {"mean": 4.0, "std": float("nan")}

    try:
        got = stats()
        std = got.get("std")
        out({"raised": False, "mean": got.get("mean"), "std": "NaN" if isinstance(std, float) and std != std else std, "implRuns": state["impl_runs"]})
    except BaseException as err:
        out({"raised": True, "error": str(err), "implRuns": state["impl_runs"]})

elif step == "clock-random":
    out({"now": shadowlap.now(), "random": shadowlap.random(), "uuid": shadowlap.uuid()})

elif step == "scope-record":
    with shadowlap.scope("a"):
        a = branch("a")
    with shadowlap.scope("b"):
        b = branch("b")
    out({"a": a, "b": b})

elif step == "scope-replay":
    # Reverse order on purpose: without scopes the two branches swap answers.
    with shadowlap.scope("b"):
        b = branch("b")
    with shadowlap.scope("a"):
        a = branch("a")
    out({"a": a, "b": b})

elif step in ("impl-hash-a", "impl-hash-b"):
    # Same name, same arguments, different source: only the implHash may differ.
    if step == "impl-hash-a":

        @shadowlap.tool(name="stable", effect="read")
        def stable(k):
            state["impl_runs"] += 1
            return "value"

    else:

        @shadowlap.tool(name="stable", effect="read")
        def stable(k):
            state["impl_runs"] += 1
            result = "value"  # rewritten body, same behaviour
            return result

    out({"result": stable(k=1), "implRuns": state["impl_runs"]})

elif step == "reads":

    @shadowlap.tool(name="fetchit", effect="read")
    def fetchit(q):
        state["impl_runs"] += 1
        return "from-impl"

    ping()
    out({"result": fetchit(q="x"), "implRuns": state["impl_runs"]})

elif step == "base-scope":
    # No scope entered in code: whatever the process starts in comes from the environment.
    outer = shadowlap.current_scope()
    echo(n=1)
    with shadowlap.scope("inner"):
        inner = shadowlap.current_scope()
        echo(n=2)
    out({"scopes": [outer, inner]})

elif step == "write":
    ping()
    try:
        result = send(to="ops")
        out({"result": result, "implRuns": state["impl_runs"], "blocked": False})
    except shadowlap.ShadowlapWriteBlocked as err:
        out({"blocked": True, "tool": err.tool, "implRuns": state["impl_runs"]})

elif step == "bad-effect":
    try:
        shadowlap.tool(effect="nope")
        out({"rejected": False})
    except TypeError:
        out({"rejected": True})

elif step == "fail":
    # Recorded, the tool answers; replayed under --fail-at, it must fail without running.
    try:
        out({"result": echo(n=1), "caught": None, "implRuns": state["impl_runs"]})
    except BaseException as err:
        out({
            "caught": {
                "name": getattr(err, "name", type(err).__name__),
                "message": str(err),
                "injected": getattr(err, "injected", False) is True,
                "timeout": isinstance(err, TimeoutError),
                "status": getattr(err, "status_code", None),
            },
            "implRuns": state["impl_runs"],
        })

else:
    out({"error": "unknown step %s" % step})
    sys.exit(1)
