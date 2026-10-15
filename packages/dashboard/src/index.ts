export { startDashboard } from './server.js';
export type { Dashboard, DashboardOptions, SpawnCli } from './server.js';
export { actionArgs, actionsFor, callDetail, compare, listRuns, runDetail } from './api.js';
export { exportHtml, withAncestors } from './static.js';
export type { ExportHtmlOptions, ExportHtmlResult, StaticPayload } from './static.js';
export type { ActionItem, CallDetail, CallRow, RunDetail, RunListItem } from './api.js';
// Tests: the read model behind the Tests screen, and the Settings → CI workflow steps.
export { bisectChoices, bisectJob, checkedRevision, failingTests, normalizeAndTestJob, overviewTests, resultLine, runTestsJob, shortReason, testPatterns, testRunBanner, testsSummary, testsView, updateGoldensJob } from './tests.js';
export type { BisectChoices, DivergenceView, FailingTest, FailureView, FoundCommit, GoldenRow, GoldenSource, HistoryCell, TestRunBanner, TestsJob, TestsOptions, TestsSessionView, TestsSummary, TestsVerdict, TestsView } from './tests.js';
export { ACTION, ALERT_FAILURES, alertsNeeds, alertsSecret, alertsYaml, FIX_BUDGETS, fixOnFailureNeeds, fixOnFailureNever, fixOnFailureYaml, REPAIRERS, repairerKey, WORKFLOW_FILE } from './ci-yaml.js';
export type { AlertsSettings, FixOnFailureSettings } from './ci-yaml.js';
// Provider-neutral parsing of requests and responses lives in the engine, shared with the terminal UI.
export { applyDeltas, normalizeConversation, normalizeResponse } from '@shadowlap/engine';
export type { Block, Conversation, Delta, NormalizedResponse, Turn, TurnBlock } from '@shadowlap/engine';

/** Opens a URL in the default browser. Resolves false when no opener is available. */
export async function openInBrowser(url: string): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
