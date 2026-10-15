export { startDashboard } from './server.js';
export type { Dashboard, DashboardOptions } from './server.js';
export { cliSpawner, JobManager, KEEP_JOBS, MAX_RUNNING, STOP_GRACE_MS } from './jobs.js';
export type { JobBuild, JobBuildContext, JobBuildResult, JobKind, JobRequest, ProjectInfo, SpawnCli, SpawnCliOptions, UploadSource } from './jobs.js';
export { Router } from './router.js';
export type { Handler, Method, RouteOptions, RouteRequest } from './router.js';
export type { ProjectConfig, RouteContext } from './context.js';
export type { RouteModule } from './routes/index.js';
export { HttpError } from './http.js';
export { MAX_UPLOADS, UploadStore, UPLOAD_LIMIT } from './uploads.js';
export { activity, describeEvent, forkFlag, parseActivityCursor, type EventText } from './activity.js';
export { changesView } from './changes.js';
export { metaView } from './meta.js';
export { actionArgs, actionsFor, callDetail, compare, listRuns, lookupRun, runDetail } from './api.js';
export { exportHtml, withAncestors } from './static.js';
export type { ExportHtmlOptions, ExportHtmlResult, StaticPayload } from './static.js';
export type { ActionItem, CallDetail, CallRow, LineageNode, ReadOptions, RunDetail, RunListItem } from './api.js';
export type { ActivityIcon, ActivityItem, ActivityPage, ChangesView, JobFile, JobLink, JobListItem, JobView, LiveRun, MetaView, ProjectView, UploadView } from './views.js';
// The run page's read model (run-page.ts): the Provenance tab, show --json, and what runs and calls add for it.
export { provenance, showRunJson } from './api.js';
export { countMasked } from './run-page.js';
export type { CallFacts, MaskCounter, ProvenanceOptions, RunBlame, RunCheck, RunPageFacts, RunProvenance } from './api.js';
// Fixes: the read model behind #/fixes, the Overview's fix numbers, Needs a look and the run page's banners.
export { fixDetail, fixesSummary, fixForRun, fixHref, fixList, needsLookFixes, repairArgv } from './fixes.js';
export type { BlameStep, CandidateVerdict, FixActions, FixDetail, FixesSummary, FixForRun, FixList, FixRef, FixRow, FixRunRef, FixStep, NeedsLookItem, RepairStep, RunBlame as FixRunBlame, StepKey, StepState, VerifyRow, VerifyStep } from './fixes.js';
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
