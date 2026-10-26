// Types for python.mjs, which the framework tests run under Node as it is.

/** Why `python` can't import `modules`, or null when it can: `absent` when it or one of them isn't there at all. */
export function importFailure(python: string, modules: string): { absent: boolean; why: string } | null;
/** The first of SHADOWLAP_PYTHON, python3 and python that imports `modules`, or null when none has them installed; throws where they raise as they import, and under CI where none imports them. */
export function findPython(modules: string): string | null;
/** A function that runs the script with QUERY and returns its last JSON line. */
export function pythonAgent(python: string, script: string): (query: string) => () => Promise<unknown>;
