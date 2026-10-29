"""The `shadowlap` console script that `pip install shadowlap` adds: it runs the npm CLI at the Python
package's own version, and says plainly how to get a Node.js when there is none it can run on."""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import shadowlap
from shadowlap import _cli

POSIX = os.name != "nt"
SDK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(SDK))
CLI = os.path.join(REPO, "packages", "cli", "bin", "shadowlap.js")
BUILT = os.path.exists(os.path.join(REPO, "packages", "cli", "dist", "index.js")) and shutil.which("node")
#: The console script's entry point, as Python code to run with -c.
MAIN = "import sys; sys.path.insert(0, %r); from shadowlap._cli import main; main()" % SDK


def script(folder: str, name: str, body: str) -> str:
    path = os.path.join(folder, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write("#!/bin/sh\n" + body + "\n")
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    return path


def run(argv, path, extra_env=None):
    """The console script's entry point, as a process with only `path` on PATH."""
    env = {"PATH": path, "HOME": os.environ.get("HOME", tempfile.gettempdir()), **(extra_env or {})}
    # -B: its environment is its own, so nothing tells it not to write bytecode beside the SDK.
    return subprocess.run([sys.executable, "-B", "-c", MAIN, *argv], env=env, capture_output=True, text=True, timeout=60)


@unittest.skipUnless(POSIX, "the fake node and npx here are shell scripts")
class ConsoleScript(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.log = os.path.join(self.dir, "argv.log")

    def fake_node(self, version="v22.18.0"):
        script(self.dir, "node", 'if [ "$1" = "--version" ]; then echo %s; exit 0; fi\necho node "$@" >> %s' % (version, self.log))

    def fake_npx(self, code=0):
        script(self.dir, "npx", 'echo npx "$@" >> %s\nexit %d' % (self.log, code))

    def logged(self):
        with open(self.log, encoding="utf-8") as f:
            return f.read().strip()

    def test_it_runs_the_cli_of_its_own_version_through_npx(self):
        self.fake_node()
        self.fake_npx()
        out = run(["replay", "01ABC", "--summary-json", "out.json"], self.dir)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(self.logged(), "npx --yes shadowlap@%s replay 01ABC --summary-json out.json" % shadowlap.__version__)

    def test_the_cli_exit_status_is_its_own(self):
        self.fake_node()
        self.fake_npx(code=3)
        self.assertEqual(run(["test", "goldens"], self.dir).returncode, 3)

    def test_without_node_it_says_how_to_get_one(self):
        out = run(["ls"], self.dir)
        self.assertEqual(out.returncode, 2)
        self.assertIn("there is no node on PATH", out.stderr)
        self.assertIn("Install Node.js 22.16 or later (not 23)", out.stderr)
        self.assertIn(shadowlap.__version__, out.stderr)

    def test_a_node_too_old_or_23_is_named(self):
        for version in ("v20.11.1", "v22.12.0", "v23.9.0"):
            with self.subTest(version=version):
                self.fake_node(version)
                self.fake_npx()
                out = run(["ls"], self.dir)
                self.assertEqual(out.returncode, 2)
                self.assertIn("is %s" % version[1:], out.stderr)
                self.assertFalse(os.path.exists(self.log), "nothing was run")

    def test_node_24_and_later_run_it(self):
        self.fake_node("v24.3.0")
        self.fake_npx()
        self.assertEqual(run(["--version"], self.dir).returncode, 0)

    def test_an_npm_install_of_the_same_version_on_path_runs_without_npx(self):
        self.fake_node()
        self.fake_npx()
        package = os.path.join(self.dir, "lib", "node_modules", "shadowlap")
        os.makedirs(os.path.join(package, "bin"))
        with open(os.path.join(package, "package.json"), "w") as f:
            json.dump({"name": "shadowlap", "version": shadowlap.__version__}, f)
        entry = os.path.join(package, "bin", "shadowlap.js")
        open(entry, "w").close()
        bin_dir = os.path.join(self.dir, "bin")
        os.makedirs(bin_dir)
        os.symlink(entry, os.path.join(bin_dir, "shadowlap"))
        out = run(["ls"], self.dir + os.pathsep + bin_dir)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(self.logged(), "node %s ls" % os.path.realpath(entry))

    def test_another_version_installed_with_npm_is_passed_over_for_npx(self):
        package = os.path.join(self.dir, "pkg")
        os.makedirs(os.path.join(package, "bin"))
        with open(os.path.join(package, "package.json"), "w") as f:
            json.dump({"name": "shadowlap", "version": "0.0.1"}, f)
        entry = os.path.join(package, "bin", "shadowlap.js")
        open(entry, "w").close()
        os.symlink(entry, os.path.join(self.dir, "shadowlap"))
        self.assertIsNone(_cli.installed_cli(self.dir))

    def test_shadowlap_cli_names_another(self):
        self.fake_node()
        out = run(["ls"], self.dir, {"SHADOWLAP_CLI": "/repo/packages/cli/bin/shadowlap.js"})
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(self.logged(), "node /repo/packages/cli/bin/shadowlap.js ls")

    def console_script(self):
        """This console script as the `shadowlap` on PATH, as pip installs it. Each start is logged, and
        the sixth runs nothing, so one that runs itself without end ends there."""
        count = os.path.join(self.dir, "starts")
        script(self.dir, "shadowlap", 'echo shadowlap "$@" >> %s\nn=0; [ -f %s ] && read n < %s; n=$((n + 1)); echo $n > %s\n[ $n -gt 5 ] && exit 99\nexec %s -B -c "%s" "$@"' % (self.log, count, count, count, sys.executable, MAIN))

    def test_it_never_runs_itself_through_shadowlap_cli(self):
        # SHADOWLAP_CLI=shadowlap names this command, not the CLI: it would run itself without end.
        self.fake_node()
        self.console_script()
        out = run(["ls"], self.dir, {"SHADOWLAP_CLI": "shadowlap"})
        self.assertEqual(out.returncode, 2, out.stderr)
        self.assertEqual(self.logged(), "shadowlap ls")
        self.assertEqual(
            out.stderr.strip(),
            "shadowlap: SHADOWLAP_CLI=shadowlap ran this command again (the shadowlap that pip install shadowlap gives, not the CLI), and it would go on "
            "without end. Point SHADOWLAP_CLI at the CLI itself, its bin/shadowlap.js or a shadowlap that npm installed, or unset it, and this command runs the CLI from npm.",
        )

    def test_nor_through_an_npx_that_finds_it(self):
        # An npx that runs the shadowlap on PATH for the package it was asked for, which is this command.
        self.fake_node()
        self.console_script()
        npx = script(self.dir, "npx", 'echo npx "$@" >> %s\nshift 2\nexec shadowlap "$@"' % self.log)
        out = run(["ls"], self.dir)
        self.assertEqual(out.returncode, 2, out.stderr)
        self.assertEqual(self.logged(), "npx --yes shadowlap@%s ls\nshadowlap ls" % shadowlap.__version__)
        self.assertIn("shadowlap: %s, which this command ran to run the CLI, ran this command again" % npx, out.stderr)
        self.assertIn("Install the CLI with npm install -g shadowlap@%s" % shadowlap.__version__, out.stderr)


@unittest.skipUnless(POSIX and BUILT, "the shadowlap CLI of this repository is not built")
class UnderTheCli(unittest.TestCase):
    def test_an_agent_the_cli_runs_runs_this_command_as_any_other(self):
        # The CLI unsets the mark this command sets for it, so an agent it runs, or a script, that runs
        # shadowlap is never taken for this command running itself.
        work = tempfile.mkdtemp()
        agent = "import os, subprocess, sys; print('mark:', os.environ.get(%r)); sys.exit(subprocess.call([sys.executable, '-B', '-c', %r, '--version']))" % (_cli.RUNNING, MAIN)
        env = {**os.environ, "SHADOWLAP_CLI": CLI, "SHADOWLAP_HOME": os.path.join(work, "home"), "SHADOWLAP_TELEMETRY": "0", "NO_COLOR": "1"}
        env.pop(_cli.RUNNING, None)
        out = subprocess.run([sys.executable, "-B", "-c", MAIN, "run", "--guard", "off", "--", sys.executable, "-B", "-c", agent], cwd=work, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("mark: None", out.stdout)
        with open(os.path.join(REPO, "packages", "cli", "package.json"), encoding="utf-8") as f:
            self.assertIn(json.load(f)["version"], out.stdout)


class Declared(unittest.TestCase):
    def test_pip_install_gives_a_shadowlap_command(self):
        from importlib.metadata import entry_points

        try:
            scripts = entry_points(group="console_scripts")
        except TypeError:  # Python 3.9
            scripts = entry_points().get("console_scripts", [])
        found = [ep.value for ep in scripts if ep.name == "shadowlap"]
        if not found:
            self.skipTest("shadowlap is not installed in this environment, only imported from the source tree")
        # The same distribution can be found more than once (the source tree on sys.path, and installed).
        self.assertEqual(set(found), {"shadowlap._cli:main"})

    def test_pyproject_declares_it(self):
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pyproject.toml"), encoding="utf-8") as f:
            text = f.read()
        self.assertRegex(text, r'(?m)^\[project\.scripts\]\nshadowlap = "shadowlap\._cli:main"$')


if __name__ == "__main__":
    unittest.main()
