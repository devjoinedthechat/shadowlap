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
        json.dumps(body)  # what the real client would have to do
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
        # An agent hands a tool's error to the model as f"error: {err}" or repr(err): a replay of
        # unchanged code must hand it the same text, or the next model call forks.
        import traceback

        original = ValueError("order A-17 not found")
        shadowlap._post = Sidecar({"origin": "replayed", "callNo": 1, "outcome": "error", "error": shadowlap.serialize_error(original)})

        @tool(effect="read")
        def lookup(order: str):
            raise AssertionError("a replayed call never runs")

        with self.assertRaises(shadowlap.ReplayedError) as caught:
            lookup("A-17")
        err = caught.exception
        self.assertEqual(str(err), str(original))
        self.assertEqual(repr(err), repr(original))
        self.assertEqual(type(err).__name__, "ValueError")
        self.assertEqual(traceback.format_exception_only(type(err), err), traceback.format_exception_only(type(original), original))
        self.assertEqual((err.name, err.args[0]), ("ValueError", "order A-17 not found"))
        # One class per recorded name, so `except` clauses and `type(e) is` checks agree across calls.
        self.assertIs(type(shadowlap.ReplayedError({"name": "ValueError", "message": "again"})), type(err))
        self.assertIsNot(type(shadowlap.ReplayedError({"name": "KeyError", "message": "k"})), type(err))
        custom = shadowlap.ReplayedError({"name": "OrderMissing", "message": "A-17"})
        self.assertEqual((type(custom).__name__, str(custom)), ("OrderMissing", "A-17"))


if __name__ == "__main__":
    unittest.main()
