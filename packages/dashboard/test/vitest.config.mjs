// A run started in this folder (npx vitest run <file>) has the setup of a run started at the
// repository's root, in vitest.config.ts there, for the tests in this folder.
import { dirname } from 'node:path';
import { testsIn } from '../../../vitest.config.ts';

export default testsIn(dirname(import.meta.dirname));
