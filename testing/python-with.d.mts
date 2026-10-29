// Types for python-with.mjs, which the conformance run imports under Node as it is.

/**
 * The first of SHADOWLAP_PYTHON, python3 and python that is a Python 3.9 or later importing every one
 * of `modules` (import names, as `google.genai`), for a test that runs it as an agent's command; null
 * where none does, but a throw under CI, which installs them (.github/workflows/ci.yml).
 */
export function pythonCommand(...modules: string[]): string | null;
/**
 * A command that starts a Python 3.9 or later able to import every one of `packages` (their import
 * names are their package names here): one of the interpreters pythonCommand tries when it has them,
 * else uv, which fetches them for the run once. Null where neither can, but a throw under CI.
 */
export function pythonWith(...packages: string[]): string[] | null;
