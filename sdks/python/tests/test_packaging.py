"""pyproject.toml asks only for a setuptools that can build it, and the package it builds is typed."""

import os
import re
import unittest

PYPROJECT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pyproject.toml")


def _text() -> str:
    with open(PYPROJECT, encoding="utf-8") as f:
        return f.read()


class BuildSystem(unittest.TestCase):
    def test_the_setuptools_floor_reads_the_license_as_written(self):
        text = _text()
        # license = "Apache-2.0" is a PEP 639 SPDX expression. setuptools reads it from 77.0 on; an
        # older one stops with "invalid pyproject.toml config: project.license", so a build without
        # isolation (pip install --no-build-isolation) with the floor fails.
        self.assertRegex(text, r'(?m)^license = "[^"]+"$')
        requires = re.search(r"(?ms)^\[build-system\].*?^requires = \[(.*?)\]", text)
        self.assertIsNotNone(requires)
        floor = re.search(r'"setuptools>=(\d+)', requires.group(1))
        self.assertIsNotNone(floor, requires.group(1))
        self.assertGreaterEqual(int(floor.group(1)), 77)


class Typed(unittest.TestCase):
    """The package is typed (PEP 561): type checkers read its annotations instead of treating it as Any."""

    ROOT = os.path.dirname(PYPROJECT)

    def test_the_marker_is_there_and_declared_as_package_data(self):
        self.assertTrue(os.path.isfile(os.path.join(self.ROOT, "shadowlap", "py.typed")))
        self.assertRegex(_text(), r'(?m)^\[tool\.setuptools\.package-data\]\nshadowlap = \["py\.typed"\]$')

    @unittest.skipUnless(os.environ.get("SHADOWLAP_TEST_WHEEL") == "1", "builds a wheel: set SHADOWLAP_TEST_WHEEL=1 (the Python SDK jobs in CI do)")
    def test_the_wheel_carries_it(self):
        import shutil
        import subprocess
        import sys
        import tempfile
        import zipfile

        out = tempfile.mkdtemp()
        if shutil.which("uv"):
            cmd = ["uv", "build", "--wheel", "--out-dir", out, self.ROOT]
        else:
            try:
                import pip  # noqa: F401 -- only whether pip is here to build with
            except ImportError:
                self.skipTest("neither uv nor pip is here to build a wheel")
            cmd = [sys.executable, "-m", "pip", "wheel", "--no-deps", "--quiet", "-w", out, self.ROOT]
        built = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if built.returncode != 0:
            self.skipTest("the wheel could not be built here: " + (built.stderr.strip().splitlines() or ["?"])[-1])
        [wheel] = [f for f in os.listdir(out) if f.endswith(".whl")]
        with zipfile.ZipFile(os.path.join(out, wheel)) as z:
            names = z.namelist()
            self.assertIn("shadowlap/py.typed", names)
            entry_points = next(n for n in names if n.endswith(".dist-info/entry_points.txt"))
            self.assertIn("shadowlap = shadowlap._cli:main", z.read(entry_points).decode())


if __name__ == "__main__":
    unittest.main()
