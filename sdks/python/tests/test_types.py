"""The SDK is typed to mypy's strictest settings (pyproject.toml's [tool.mypy]). CI runs mypy in its own
job; this runs it too wherever mypy is installed, so a change that loosens a type fails here first."""

import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

try:
    import mypy
except ImportError:
    mypy = None


@unittest.skipUnless(mypy, "mypy is not installed")
class Strict(unittest.TestCase):
    def test_mypy_strict_passes(self):
        out = subprocess.run([sys.executable, "-m", "mypy"], cwd=ROOT, capture_output=True, text=True, timeout=600)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("Success: no issues found", out.stdout)


if __name__ == "__main__":
    unittest.main()
