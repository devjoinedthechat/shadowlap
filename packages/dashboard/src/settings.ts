/**
 * The read model behind Settings: one plain function per tab (Matching, Redaction, Coding agents,
 * Tools, Project), store and project folder in, JSON out, no HTTP. Edits go through the engine's
 * config-file module (addRule, removeRule, setClock), which takes the `version` returned here so a
 * page showing an old list can't remove the wrong rule; jobs run the CLI for calibrate and gc.
 *
 * Settings opens before a project has runs, so nothing here needs a run, and a config file that
 * can't be read is reported on the page rather than failing it.
 *
 * Each tab has a module of its own (settings-matching.ts, settings-redaction.ts, settings-agents.ts,
 * settings-tools.ts with the MCP servers in settings-mcp.ts, settings-project.ts, settings-store.ts),
 * and what they share is in settings-shared.ts. This one exports them all.
 */

export { type SettingsContext, type ConfigInfo, type RuleRow, type RuleForm, configFileError, shortCommand, SettingsRefusal } from './settings-shared.js';
export { agentsSection, mcpClientConfig, readShippedDoc } from './settings-docs.js';
export { type MatchingSettings, matchingSettings, proposedRules } from './settings-matching.js';
export { type RedactionSettings, redactionSettings, type RedactionPreviewView, redactionPreview } from './settings-redaction.js';
export { type AgentFile, type CodingAgentsSettings, codingAgentsSettings } from './settings-agents.js';
export { hideSecrets, hideUrlSecrets } from './settings-secrets.js';
export { type McpServerRow, type McpRecordedServer, type ClientConfigBlock, stdioServerName, parseJsonc, splitCommandLine, clientConfigs, type ServerFor, mcpServerFor, mcpEntryAsTyped, mcpServers } from './settings-mcp.js';
export { type ToolRow, type HttpHostRow, type ToolsSettings, toolsSettings } from './settings-tools.js';
export { type ProjectSettings, CLEANUP_DAYS, projectSettings, cleanupArgv, shownPath, notCalibratable, calibrateRun } from './settings-project.js';
export { type StoreSettings, storeSettings } from './settings-store.js';

