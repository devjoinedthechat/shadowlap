"""``shadowlap`` on the command line, from the Python package.

The CLI is a Node.js program, published to npm as ``shadowlap``. This console script runs that CLI at
this package's own version, so ``pip install shadowlap`` gives a ``shadowlap`` command whose
recordings and SDK speak the same protocol: a ``shadowlap`` of that version installed with npm when
there is one on ``PATH``, otherwise ``npx --yes shadowlap@<version>``, which fetches it once. Without
a Node.js it can run on, it says how to get one. ``SHADOWLAP_CLI`` names another CLI to run instead
(a JavaScript file, run with ``node``, or a program), as it does for the pytest plugin.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from typing import Callable, NoReturn, Optional

from shadowlap import __version__

#: The Node.js the CLI runs on, as its package.json's ``engines`` says: 22.16 or later, but not 23,
#: whose built-in SQLite lacks the full-text search every Shadowlap store uses.
NODE_RANGE = "22.16 or later (not 23)"

#: Exit status when there is no Node.js to run the CLI on: a matter of setup, as a bad flag is.
EXIT_SETUP = 2

Which = Callable[[str], Optional[str]]


class NoRuntime(Exception):
    """The CLI can't be run here; the message says why and what to do."""


def node_version(node: str) -> Optional[tuple[int, int, int]]:
    """The version ``node --version`` prints, or None when it can't be run or read."""
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"^v?(\d+)\.(\d+)\.(\d+)", out)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def node_supported(version: tuple[int, int, int]) -> bool:
    major, minor, _ = version
    return (major == 22 and minor >= 16) or major >= 24


def _get_node() -> str:
    return (
        f"Install Node.js {NODE_RANGE}: from nodejs.org, your system's package manager, or a version manager "
        "such as nvm, fnm or volta. Then run shadowlap again: it runs the shadowlap CLI from npm at "
        f"this package's version, {__version__}. The Python SDK itself (shadowlap.tool, the pytest plugin's "
        "recordings) needs no Node.js in the agent's process."
    )


def _node(which: Which) -> str:
    """A node this CLI runs on, or NoRuntime saying what's wrong."""
    node = which("node")
    if not node:
        raise NoRuntime("shadowlap: the shadowlap CLI runs on Node.js, and there is no node on PATH. " + _get_node())
    version = node_version(node)
    if version is None:
        raise NoRuntime(f"shadowlap: {node} did not say which version it is. " + _get_node())
    if not node_supported(version):
        raise NoRuntime("shadowlap: the shadowlap CLI needs Node.js %s, and %s is %d.%d.%d. %s" % (NODE_RANGE, node, version[0], version[1], version[2], _get_node()))
    return node


def installed_cli(path: Optional[str] = None, me: Optional[str] = None) -> Optional[str]:
    """The CLI's JavaScript entry point of a ``shadowlap`` that npm installed on ``PATH`` at this
    package's version, or None. Read from the package.json beside it, so nothing is run to find out;
    this console script, also named ``shadowlap``, is skipped."""
    own = os.path.realpath(me or sys.argv[0] or "")
    for folder in (path if path is not None else os.environ.get("PATH", "")).split(os.pathsep):
        candidate = os.path.join(folder, "shadowlap")
        if not folder or not os.path.isfile(candidate):
            continue
        real = os.path.realpath(candidate)
        if real == own or not real.endswith(".js"):
            continue
        manifest = os.path.join(os.path.dirname(os.path.dirname(real)), "package.json")
        try:
            with open(manifest, encoding="utf-8") as f:
                pkg = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(pkg, dict) and pkg.get("name") == "shadowlap" and pkg.get("version") == __version__:
            return real
    return None


def _npx(node: str, which: Which) -> list[str]:
    """npx, as a command to run. On Windows npx is a batch file, so npm's own script is run with node
    when it is where npm puts it, which keeps cmd.exe out of the arguments."""
    if os.name == "nt":
        script = os.path.join(os.path.dirname(node), "node_modules", "npm", "bin", "npx-cli.js")
        if os.path.isfile(script):
            return [node, script]
    npx = which("npx")
    if not npx:
        raise NoRuntime(f"shadowlap: there is no npx beside {node}, which npm brings: install npm (it comes with Node.js), or install the CLI itself with npm install -g shadowlap@{__version__}.")
    return [npx]


def command(args: Sequence[str], env: Optional[Mapping[str, str]] = None, which: Which = shutil.which, path: Optional[str] = None) -> list[str]:
    """The command that runs the CLI with ``args``. Raises NoRuntime when there is none to run."""
    env = os.environ if env is None else env
    override = env.get("SHADOWLAP_CLI")
    if override:
        if override.endswith((".js", ".mjs", ".cjs")):
            return [_node(which), override, *args]
        return [override, *args]
    node = _node(which)
    installed = installed_cli(path if path is not None else env.get("PATH", ""))
    if installed:
        return [node, installed, *args]
    return [*_npx(node, which), "--yes", f"shadowlap@{__version__}", *args]


def main(argv: Optional[Sequence[str]] = None) -> NoReturn:
    """Runs the CLI with this process's arguments, as this process: its exit status is the CLI's."""
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        cmd = command(args)
    except NoRuntime as err:
        print(str(err), file=sys.stderr)
        sys.exit(EXIT_SETUP)
    sys.stdout.flush()
    sys.stderr.flush()
    if os.name != "nt":
        # Replaced, not wrapped: signals reach the CLI directly, and its exit status is this one.
        try:
            os.execvp(cmd[0], cmd)
        except OSError as err:
            print(f"shadowlap: could not run {cmd[0]}: {err}", file=sys.stderr)
            sys.exit(EXIT_SETUP)
    try:
        sys.exit(subprocess.call(cmd))
    except KeyboardInterrupt:
        sys.exit(130)
    except OSError as err:
        print(f"shadowlap: could not run {cmd[0]}: {err}", file=sys.stderr)
        sys.exit(EXIT_SETUP)


if __name__ == "__main__":
    main()
