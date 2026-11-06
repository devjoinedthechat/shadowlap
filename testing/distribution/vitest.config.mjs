// A run started in this folder (npx vitest run test/<file>) has the setup every run of the tests has:
// the repository's, in vitest.config.ts at its root, for the tests in this folder.
import { testsIn } from '../../vitest.config.ts';

export default testsIn(import.meta.dirname);
