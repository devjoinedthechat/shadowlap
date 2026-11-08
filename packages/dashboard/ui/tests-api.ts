import { ciQuery } from './goldens.js';
import type { Request } from './settings-api.js';
import type { CiWorkflowOptions, CiWorkflowsView, TestEvidence, TestRunView, TestsAnswer } from './types.js';

/** Tests' reads, flat on the client as they always were (`client.tests()`), written beside their routes (src/routes/tests.ts). */
export interface TestsApi {
  /** The goldens on disk and how each did, with the report of each that didn't pass (`/api/tests`). */
  tests(): Promise<TestsAnswer>;
  /**
   * A run's test banner (a replay `shadowlap test` made that diverged) and Find breaking commit's choices
   * (`/api/tests/runs/:id`); `before` limits the good commits to runs before it, as the calendar's days do.
   */
  testRun(id: string, before?: number): Promise<TestRunView>;
  /** Settings → CI's two panels for the options given; those left out take the server's defaults (`/api/ci/workflows`). */
  ciWorkflows(options?: Partial<CiWorkflowOptions>): Promise<CiWorkflowsView>;
  /** A gated golden's attempts, each judged from its run, those carried over first (`/api/tests/evidence`): asked when the row under it opens, never with the page. */
  testEvidence(golden: string): Promise<TestEvidence>;
}

export function testsApi(request: Request): TestsApi {
  const id = encodeURIComponent;
  return {
    tests: () => request<TestsAnswer>('tests'),
    testRun: (runId, before) => request<TestRunView>(`tests/runs/${id(runId)}${before !== undefined ? `?before=${before}` : ''}`),
    ciWorkflows: (o) => request<CiWorkflowsView>(`ci/workflows${ciQuery(o)}`),
    testEvidence: (golden) => request<TestEvidence>(`tests/evidence?golden=${id(golden)}`),
  };
}
