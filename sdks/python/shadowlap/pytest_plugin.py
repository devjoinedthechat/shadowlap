"""pytest plugin: ``@pytest.mark.shadowlap`` records a test's model and tool calls the first time it
runs and replays them offline after that. Loaded automatically once shadowlap is installed; it does
nothing for tests without the marker.

    import pytest

    @pytest.mark.shadowlap
    def test_triage(shadowlap_recording):
        result = run_agent("triage the inbox")
        assert len(result.tickets) == 3
        assert shadowlap_recording.called("send_email") == 0

The ``shadowlap_recording`` fixture is the test's :class:`shadowlap.testing.Recording`, to assert on the
calls the agent made. A recording lives next to the test, in ``__recordings__/<test file>/<test name>``;
commit it. Pass
``@pytest.mark.shadowlap(recording="path")`` to put it elsewhere. ``--shadowlap-record`` (or
``SHADOWLAP_RECORD``) picks the mode: ``missing``, ``all`` or ``none``; see :mod:`shadowlap.testing`.

It loads into every pytest run once shadowlap is installed, so it uses only what every pytest from 6.2
on has, with the pluggy each one allows: old-style hook wrappers, and the recording kept on the item.
"""

import os
import re
from pathlib import Path

import pytest

from shadowlap import testing


def pytest_addoption(parser):
    group = parser.getgroup("shadowlap")
    group.addoption(
        "--shadowlap-record",
        choices=testing.MODES,
        default=None,
        help="tests marked shadowlap: replay a recording when there is one and record otherwise (missing, the default), record all again (all), or only replay (none, the default in CI)",
    )


def pytest_configure(config):
    config.addinivalue_line("markers", "shadowlap(recording=None): record the test's model and tool calls on its first run and replay them offline after that")


def pytest_unconfigure(config):
    testing.close()


# Kept on the item: pytest.StashKey and item.stash only exist from pytest 7.0.
_RECORDING = "_shadowlap_recording"
_FAILURE = "_shadowlap_failure"


def _recording_for(item):
    """The marked test's recording, created once: by the fixture during setup or when the test body runs."""
    rec = getattr(item, _RECORDING, None)
    if rec is None:
        marker = item.get_closest_marker("shadowlap")
        path = marker.kwargs.get("recording") or _recording_path(item)
        if not os.path.isabs(path):
            path = str(Path(str(item.config.rootpath)) / path)
        rec = testing.Recording(path, name=item.nodeid, mode=item.config.getoption("shadowlap_record"), command=["pytest", item.nodeid], root=str(item.config.rootpath))
        setattr(item, _RECORDING, rec)
    return rec


@pytest.fixture
def shadowlap_recording(request):
    """The test's recording: ``shadowlap_recording.called("send_email")``, ``.tool_calls()``, ``.calls()``, ``.answer()``."""
    if request.node.get_closest_marker("shadowlap") is None:
        raise pytest.fail.Exception("shadowlap_recording needs the test to be marked @pytest.mark.shadowlap", pytrace=False)
    return _recording_for(request.node)


def _recording_path(item) -> str:
    path = Path(str(getattr(item, "path", None) or item.fspath))
    name = re.sub(r"[^\w.-]+", "-", item.name).strip("-")[:120] or "test"
    return str(path.parent / "__recordings__" / path.stem / name)


# Old-style wrappers (hookwrapper=True), which every pluggy has: wrapper=True needs pluggy 1.2, and
# pytest 7.4 allows 1.1. An old-style wrapper doesn't raise after its yield (pluggy warns about that,
# and older ones don't route it), so a divergence found when the test ends is made the test's
# failure in its report.
@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    marker = item.get_closest_marker("shadowlap")
    if marker is None or testing.under_shadowlap_run():
        yield
        return
    rec = _recording_for(item)
    try:
        rec.start()
    except testing.ShadowlapTestError as err:
        raise pytest.fail.Exception("shadowlap: %s" % err, pytrace=False) from None
    outcome = yield
    excinfo = outcome.excinfo
    try:
        if excinfo is None:
            rec.finish(True)
        else:
            rec.finish(False, excinfo[1])
    except testing.ShadowlapReplayDiverged as err:
        setattr(item, _FAILURE, str(err))
    except testing.ShadowlapTestError as err:
        setattr(item, _FAILURE, "shadowlap: %s" % err)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    failure = getattr(item, _FAILURE, None)
    if failure is None or call.when != "call":
        return
    # The divergence explains whatever the test then did, so it is the failure pytest shows.
    report = outcome.get_result()
    report.outcome = "failed"
    report.longrepr = failure
    if hasattr(report, "wasxfail"):
        del report.wasxfail
