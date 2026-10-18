"""pyproject.toml asks only for a setuptools that can build it."""

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


if __name__ == "__main__":
    unittest.main()
