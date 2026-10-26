// Python framework tests run a script as a subprocess against the harness's in-process sidecar.
// SHADOWLAP_PYTHON picks the interpreter, before python3 and python, as pythonWith picks one for the
// suite's own Python tests (packages/cli/test/python-with.ts). A suite skips where no interpreter has
// its framework installed, but not under CI, whose frameworks job installs every one: there it fails,
// saying so, rather than skip and leave the run green. Anywhere, a framework that is installed but
// raises as it imports fails its suite, with the error.
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Why `python` can't import `modules` (`'requests, httpx'`), or null when it can: `absent` when it
 * is no Python (none on the PATH, Windows' store alias) or one of the modules isn't installed there at
 * all, as opposed to one that is and raises as it imports (a dependency missing, a version that
 * conflicts).
 */
export function importFailure(python, modules) {
  const r = spawnSync(python, ['-B', '-c', `import ${modules}`], { encoding: 'utf8', timeout: 300_000 });
  if (r.error) return { absent: r.error.code === 'ENOENT', why: r.error.message };
  if (r.status === 0) return null;
  const stderr = r.stderr.trim();
  const last = stderr.split('\n').at(-1) ?? '';
  // `No module named 'llama_index'` or `'llama_index.core'`: the framework itself isn't there.
  const own = modules.split(',').flatMap((m) => m.trim().split('.').map((_, i, parts) => parts.slice(0, i + 1).join('.')));
  const raised = stderr.includes('Traceback (most recent call last):');
  const absent = !raised || own.some((name) => last === `ModuleNotFoundError: No module named '${name}'`);
  return { absent, why: last || `it exited with status ${r.status}` };
}

/**
 * The first of SHADOWLAP_PYTHON, python3 and python that imports `modules`, or null when none has
 * them installed (the suite then skips). Throws where one has them but they raise as they import,
 * and under CI where none imports them.
 */
export function findPython(modules) {
  const failures = [];
  for (const cmd of [process.env.SHADOWLAP_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const failed = importFailure(cmd, modules);
    if (!failed) return cmd;
    failures.push({ cmd, ...failed });
  }
  const broken = failures.find((f) => !f.absent);
  if (broken) throw new Error(`${broken.cmd} has ${modules} but can't import it, so this suite can't run: ${broken.why}`);
  if (process.env.CI) {
    const tried = failures.map((f) => `${f.cmd}: ${f.why}`).join('; ');
    throw new Error(`no Python here imports ${modules}, which CI installs for this suite (.github/workflows/frameworks.yml): without it the suite would skip, and the run would pass with it left out (${tried})`);
  }
  return null;
}

/** A function that runs the script with QUERY and returns its last JSON line. Async on purpose: the sidecar serves from this event loop. */
export function pythonAgent(python, script) {
  const path = fileURLToPath(new URL(script, import.meta.url));
  return (query) => async () => {
    const { stdout } = await promisify(execFile)(python, [path], { env: { ...process.env, QUERY: query }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout.trim().split('\n').pop());
  };
}
