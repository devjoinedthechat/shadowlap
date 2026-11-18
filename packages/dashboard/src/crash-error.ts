import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseTraceback, type ParsedTraceback, type TestResult } from '@shadowlap/engine';

/**
 * What a crash died of, as Tests' report and a fix's Blame step both draw it (ui/tests/ErrorPart.tsx):
 * the exception the engine's parser read from the lines the agent printed last, the file it was raised
 * in, and those lines as the store kept them.
 */
export interface CrashError {
  error: ParsedTraceback;
  /** The file the agent's own code raised it in, named from the project folder (with `/`) where it is inside it; null where the lines kept no frame of the agent's. */
  file: string | null;
  lines: string[];
}

/** The project's own name for a file the agent's traceback names: relative where it is inside the folder, with `/` between its parts on every system, else as printed. */
function fileHere(file: string, project: string | null): string {
  if (!project || !isAbsolute(file)) return file;
  const rel = relative(project, resolve(file));
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : file;
}

/** The exception a result's attempt died of, from the lines it printed last; null where none reads as one. */
export function crashError(r: TestResult, project: string | null): CrashError | null {
  const output = r.data?.output;
  const error = output ? parseTraceback(output) : null;
  return error && output ? { error, file: error.raised ? fileHere(error.raised.file, project) : null, lines: output.split('\n') } : null;
}

