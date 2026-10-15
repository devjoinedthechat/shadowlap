export { startDashboard } from './server.js';
export type { Dashboard, DashboardOptions, SpawnCli } from './server.js';
export { actionArgs, actionsFor, callDetail, compare, listRuns, runDetail } from './api.js';
export { exportHtml, withAncestors } from './static.js';
export type { ExportHtmlOptions, ExportHtmlResult, StaticPayload } from './static.js';
export type { ActionItem, CallDetail, CallRow, RunDetail, RunListItem } from './api.js';
// Settings: one read model per tab; edits go through the engine's config-file module.
export { CLEANUP_DAYS, agentsSection, cleanupArgv, codingAgentsSettings, hideSecrets, hideUrlSecrets, matchingSettings, mcpClientConfig, mcpServerFor, mcpServers, parseJsonc, previewArgv, projectSettings, proposedRules, readShippedDoc, redactionSettings, splitCommandLine, stdioServerName, toolsSettings } from './settings.js';
export type { AgentFile, CodingAgentsSettings, ConfigInfo, HttpHostRow, MatchingSettings, McpRecordedServer, McpServerRow, ProjectSettings, RedactionSettings, RuleForm, RuleRow, SettingsContext, ToolRow, ToolsSettings } from './settings.js';
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
