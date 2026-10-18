"""What the Python SDK records: framework context left out, clear errors for what can't be recorded,
and results converted to JSON. The sidecar is stubbed; the vitest suite runs this file."""

import dataclasses
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import shadowlap  # noqa: E402
from shadowlap import ShadowlapWriteBlocked, context_params, tool  # noqa: E402


class Sidecar:
    """Answers resolve with a fixed decision and keeps what the SDK sent."""

    def __init__(self, decision):
        self.decision = decision
        self.sent = []

    def __call__(self, cfg, path, body):
        json.dumps(body, allow_nan=False)  # what the real sidecar accepts: JSON has no NaN
        self.sent.append((path, body))
        return dict(self.decision) if path.endswith("/resolve") else {}


class RecordingRules(unittest.TestCase):
    def setUp(self):
        self._post = shadowlap._post
        os.environ["SHADOWLAP_URL"] = "http://sidecar.test"

    def tearDown(self):
        shadowlap._post = self._post
        os.environ.pop("SHADOWLAP_URL", None)

    def test_framework_context_parameters_are_detected_by_annotation(self):
        def fn(ctx: "RunContextWrapper[Deps]", tc: "ToolContext", run: "RunContext[None]", config: "RunnableConfig", state: "Annotated[dict, InjectedState]", call_id: "Annotated[str, InjectedToolCallId]", run_manager: "Optional[CallbackManagerForToolRun]", query: str, context: dict, limit: int = 3):
            pass

        self.assertEqual(context_params(fn), ("ctx", "tc", "run", "config", "state", "call_id", "run_manager"))

    def test_a_description_that_names_a_context_type_does_not_make_an_argument_context(self):
        # Annotated's description strings are documentation, not types: a parameter whose
        # description mentions Injected... or ToolContext is still the tool's real input.
        from typing import Annotated, Optional

        class InjectedToolArg:  # LangChain's marker, as far as the SDK can tell
            pass

        class InjectedState:
            def __init__(self, field=None):
                self.field = field

        class RunContext:
            def __class_getitem__(cls, item):
                return cls

        class CallbackManagerForToolRun:
            pass

        def summarize(
            text: Annotated[str, "Injected document text to summarize"],
            style: Annotated[str, "Tone; see ToolContext docs"],
            call_id: Annotated[str, InjectedToolArg],
            state: Annotated[dict, InjectedState("messages"), "the graph's state"],
            ctx: RunContext,
            run_manager: Optional[CallbackManagerForToolRun],
            limit: Annotated[int, "Max words"] = 50,
        ):
            pass

        self.assertEqual(context_params(summarize), ("call_id", "state", "ctx", "run_manager"))

        def quoted(text: "Annotated[str, 'Injected document text']", note: 'Annotated[str, "see RunContext"]', state: "Annotated[dict, InjectedState]"):
            pass

        self.assertEqual(context_params(quoted), ("state",))

    def test_context_is_left_out_of_the_recording(self):
        sidecar = Sidecar({"origin": "live", "callNo": 1})
        shadowlap._post = sidecar

        class Wrapper:
            pass

        @tool(effect="read")
        def search(ctx: "RunContextWrapper[dict]", query: str) -> str:
            return "hit " + query

        self.assertEqual(search(Wrapper(), "x"), "hit x")
        self.assertEqual(sidecar.sent[0][1]["args"], {"query": "x"})

    def test_an_argument_that_is_not_json_fails_before_the_tool_runs_and_names_itself(self):
        shadowlap._post = Sidecar({"origin": "live", "callNo": 1})
        ran = []

        @tool(effect="write")
        def send(client: object, to: str) -> str:
            ran.append(to)
            return "sent"

        with self.assertRaises(TypeError) as caught:
            send(object(), "team@example.com")
        self.assertIn("argument 'client' (object) can't be recorded", str(caught.exception))
        self.assertIn("exclude=('client',)", str(caught.exception))
        self.assertEqual(ran, [])

    def test_model_dataclass_date_and_other_typed_arguments_are_recorded_as_json(self):
        # Pydantic AI validates a tool's typed arguments into these types before calling it; they
        # are the tool's real input, and recorded by the rules results already follow.
        import datetime
        import decimal
        import enum
        import uuid

        sidecar = Sidecar({"origin": "live", "callNo": 1})
        shadowlap._post = sidecar

        class Priority(enum.Enum):
            HIGH = "high"

        class Ticket:  # a Pydantic model, as far as the SDK can tell
            def __init__(self, subject):
                self.subject = subject

            def model_dump(self, mode="python"):
                return {"subject": self.subject, "mode": mode}

        @dataclasses.dataclass
        class Window:
            start: datetime.date
            hours: float

        got = []

        @tool(effect="write")
        def open_ticket(ticket: Ticket, day: datetime.date, at: datetime.datetime, window: Window, priority: Priority, ref: uuid.UUID, amount: decimal.Decimal, tags: frozenset):
            got.append((ticket, day, priority))
            return "T-1"

        ticket = Ticket("refund")
        ref = uuid.UUID("12345678-1234-5678-1234-567812345678")
        day = datetime.date(2026, 10, 18)
        self.assertEqual(open_ticket(ticket, day, datetime.datetime(2026, 10, 18, 9, 30), Window(day, 1.5), Priority.HIGH, ref, decimal.Decimal("12.50"), frozenset({"b", "a"})), "T-1")
        self.assertEqual(got, [(ticket, day, Priority.HIGH)])  # the tool still gets the objects themselves
        self.assertEqual(sidecar.sent[0][1]["args"], {
            "ticket": {"subject": "refund", "mode": "json"},
            "day": "2026-10-18",
            "at": "2026-10-18T09:30:00",
            "window": {"start": "2026-10-18", "hours": 1.5},
            "priority": "high",
            "ref": "12345678-1234-5678-1234-567812345678",
            "amount": "12.50",
            "tags": ["a", "b"],
        })

    def test_dataclass_and_model_results_are_recorded_as_json(self):
        sidecar = Sidecar({"origin": "live", "callNo": 1})
        shadowlap._post = sidecar

        @dataclasses.dataclass
        class Hit:
            title: str
            score: float

        class Model:
            def model_dump(self, mode="python"):
                return {"mode": mode}

        @tool(effect="pure")
        def best(query: str):
            return Hit(query, 0.9)

        @tool(effect="pure")
        def modeled(query: str):
            return Model()

        self.assertIsInstance(best("q"), Hit)  # the live caller still gets the object
        self.assertIsInstance(modeled("q"), Model)
        completes = [body for path, body in sidecar.sent if path.endswith("/complete")]
        self.assertEqual(completes[0]["result"], {"title": "q", "score": 0.9})
        self.assertEqual(completes[1]["result"], {"mode": "json"})

    def test_an_unrecordable_result_completes_the_call_as_an_error(self):
        sidecar = Sidecar({"origin": "live", "callNo": 7})
        shadowlap._post = sidecar

        @tool(effect="read")
        def opens(path: str):
            return object()

        with self.assertRaises(TypeError):
            opens("x")
        path, body = sidecar.sent[-1]
        self.assertEqual(path, "/v1/calls/7/complete")
        self.assertEqual(body["outcome"], "error")
        self.assertIn("can't be recorded", body["error"]["message"])

    def test_a_non_finite_float_is_recorded_as_null_and_the_tool_still_returns_its_result(self):
        # JSON has no NaN or Infinity: the sidecar refused the body, and the call was left pending
        # after the tool had run. They are recorded as null, as the TypeScript SDK's JSON does.
        sidecar = Sidecar({"origin": "live", "callNo": 3})
        shadowlap._post = sidecar
        ran = []

        @tool(effect="read")
        def stats(column: str, cutoff: float = float("inf")):
            ran.append(column)
            return {"mean": 4.0, "std": float("nan"), "range": [float("-inf"), 9.5], "pair": (1.0, float("nan"))}

        got = stats("refunds")
        self.assertEqual(ran, ["refunds"])
        self.assertTrue(got["std"] != got["std"])  # the live caller still gets its own value
        resolve, complete = sidecar.sent
        self.assertEqual(resolve[1]["args"], {"column": "refunds", "cutoff": None})
        self.assertEqual(complete[0], "/v1/calls/3/complete")
        self.assertEqual(complete[1]["outcome"], "ok")
        self.assertEqual(complete[1]["result"], {"mean": 4.0, "std": None, "range": [None, 9.5], "pair": [1.0, None]})

    def test_a_result_the_sidecar_refuses_still_completes_the_call_as_an_error(self):
        class Refusing(Sidecar):
            def __call__(self, cfg, path, body):
                if path.endswith("/complete") and body.get("outcome") == "ok":
                    self.sent.append((path, body))
                    raise RuntimeError("shadowlap sidecar %s failed (400): invalid JSON body" % path)
                return super().__call__(cfg, path, body)

        for is_async in (False, True):
            sidecar = Refusing({"origin": "live", "callNo": 4})
            shadowlap._post = sidecar

            def impl(q: str):
                return {"q": q}

            async def aimpl(q: str):
                return {"q": q}

            wrapped = tool(name="lookup", effect="read")(aimpl if is_async else impl)
            with self.assertRaises(RuntimeError):
                if is_async:
                    import asyncio

                    asyncio.run(wrapped("x"))
                else:
                    wrapped("x")
            path, body = sidecar.sent[-1]
            self.assertEqual((path, body["outcome"]), ("/v1/calls/4/complete", "error"))
            self.assertIn("invalid JSON body", body["error"]["message"])

    def test_a_blocked_write_keeps_its_message_and_arguments_apart(self):
        shadowlap._post = Sidecar({"origin": "blocked", "callNo": 1, "error": {"name": "ShadowlapWriteBlocked", "message": "write tool send blocked after divergence"}})

        @tool(effect="write")
        def send(to: str) -> str:
            return "sent"

        with self.assertRaises(ShadowlapWriteBlocked) as caught:
            send("team@example.com")
        err = caught.exception
        self.assertEqual(str(err), "write tool send blocked after divergence")
        self.assertEqual(err.tool, "send")
        self.assertEqual(err.tool_args, {"to": "team@example.com"})
        import copy
        import pickle

        for clone in (copy.copy(err), pickle.loads(pickle.dumps(err))):
            self.assertEqual((str(clone), clone.tool, clone.tool_args), (str(err), err.tool, err.tool_args))

    def test_a_replayed_error_survives_copy_and_pickle(self):
        import copy
        import pickle

        err = shadowlap.ReplayedError({"name": "FileNotFoundError", "message": "no such file", "code": "ENOENT"})
        for clone in (copy.copy(err), pickle.loads(pickle.dumps(err))):
            self.assertEqual((clone.name, clone.code, clone.args[0]), ("FileNotFoundError", "ENOENT", "no such file"))
            self.assertEqual((type(clone).__name__, str(clone), repr(clone)), (type(err).__name__, str(err), repr(err)))
            self.assertIsInstance(clone, shadowlap.ReplayedError)

    def test_a_replayed_error_reads_as_the_recorded_one(self):
        # An agent hands a tool's error to the model as f"error: {err}", or as repr(err) the way
        # LangGraph's ToolNode does: a replay of unchanged code must hand it the same text, or the
        # next model call forks. Recorded through the SDK and the JSON the sidecar stores, then replayed.
        import copy
        import pickle
        import traceback

        try:
            open("/nonexistent/orders/A-17")
        except FileNotFoundError as err:
            not_found = err
        originals = [
            ValueError("order A-17 not found"),
            KeyError("A-17"),
            not_found,
            RuntimeError(),
            ValueError("a", "b"),
            OrderMissing("gone"),
            OrderMissing({"order": "A-17", "tries": 2}),
            ValueError(("a", 1)),  # a tuple comes back from JSON a list: the message stands for it
            ValueError(object()),
        ]
        for original in originals:
            with self.subTest(original=repr(original)):

                @tool(effect="read")
                def lookup(order: str):
                    raise original

                live = Sidecar({"origin": "live", "callNo": 1})
                shadowlap._post = live
                with self.assertRaises(type(original)):
                    lookup("A-17")
                recorded = json.loads(json.dumps(live.sent[-1][1]["error"]))
                shadowlap._post = Sidecar({"origin": "replayed", "callNo": 1, "outcome": "error", "error": recorded})
                with self.assertRaises(shadowlap.ReplayedError) as caught:
                    lookup("A-17")
                err = caught.exception
                self.assertEqual(str(err), str(original))
                self.assertEqual(type(err).__name__, type(original).__name__)
                self.assertEqual(traceback.format_exception_only(type(err), err), traceback.format_exception_only(type(original), original))
                if "object at 0x" not in repr(original) and not isinstance(original.args[0] if original.args else None, tuple):
                    self.assertEqual(repr(err), repr(original))
                    self.assertEqual(err.args, original.args)
                for again in (copy.copy(err), pickle.loads(pickle.dumps(err))):
                    self.assertIs(type(again), type(err))
                    self.assertEqual((str(again), repr(again), again.args), (str(err), repr(err), err.args))

        # One class per recorded name, so `except` clauses and `type(e) is` checks agree across calls.
        first = shadowlap.ReplayedError({"name": "ValueError", "message": "once"})
        self.assertIs(type(shadowlap.ReplayedError({"name": "ValueError", "message": "again"})), type(first))
        self.assertIsNot(type(shadowlap.ReplayedError({"name": "KeyError", "message": "k"})), type(first))
        # A recording made before arguments and modules were kept still reads as it did.
        old = shadowlap.ReplayedError({"name": "ValueError", "message": "order A-17 not found"})
        self.assertEqual((str(old), repr(old), old.args), ("order A-17 not found", "ValueError('order A-17 not found')", ("order A-17 not found",)))
        custom = shadowlap.ReplayedError({"name": "OrderMissing", "message": "A-17"})
        self.assertEqual((type(custom).__name__, str(custom)), ("OrderMissing", "A-17"))


class OrderMissing(Exception):
    """An error class of the agent's own, for the replayed-error test."""

if __name__ == "__main__":
    unittest.main()
