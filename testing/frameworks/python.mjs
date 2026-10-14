// Python framework tests run a script as a subprocess against the harness's in-process sidecar.
// SHADOWLAP_PYTHON picks the interpreter; a test skips when no interpreter has its framework.
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export function findPython(module) {
  for (const cmd of [process.env.SHADOWLAP_PYTHON, 'python3', 'python'].filter(Boolean)) {
    try {
      execFileSync(cmd, ['-c', `import ${module}`], { stdio: 'ignore' });
      return cmd;
    } catch {
      // next
    }
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
