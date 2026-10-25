// Python framework tests run a script as a subprocess against the harness's in-process sidecar.
// SHADOWLAP_PYTHON names the interpreter, as CI does: then a suite's framework must import in it, and
// one that doesn't fails the suite, saying why, rather than skipping it. Without it, a suite skips
// where neither python3 nor python has its framework installed, and fails where one has it but it
// doesn't import.
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
  const r = spawnSync(python, ['-c', `import ${modules}`], { encoding: 'utf8', timeout: 300_000 });
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

/** The interpreter that imports `modules`, or null when none has them installed (the suite then skips); throws where they don't import. */
export function findPython(modules) {
  const named = process.env.SHADOWLAP_PYTHON;
  if (named) {
    const failed = importFailure(named, modules);
    if (failed) throw new Error(`SHADOWLAP_PYTHON=${named} can't import ${modules}, so this suite can't run: ${failed.why}`);
    return named;
  }
  for (const cmd of ['python3', 'python']) {
    const failed = importFailure(cmd, modules);
    if (!failed) return cmd;
    if (!failed.absent) throw new Error(`${cmd} has ${modules} but can't import it, so this suite can't run: ${failed.why}`);
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
