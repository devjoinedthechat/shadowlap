import { canonicalize } from './canonical.js';

/**
 * When the models a recording uses stop working: the providers' own deprecation pages, read on the
 * date in `RETIREMENTS_VERSION` and kept here as data, so `shadowlap decisions` and `migrate` can warn
 * that a recorded model retires without asking anyone. Nothing here calls home: a release ships the
 * table as it stood, and a newer release ships a newer one.
 *
 * Only dates a page states are kept, each row with the page it comes from:
 *
 * - a model's retirement or shutdown date, as announced. Anthropic's "not sooner than" dates for
 *   active models set no date, and are left out;
 * - Google's Gemini API gives the earliest date a model may shut down (`earliest`);
 * - Amazon Bedrock's dates differ by Region (`regions`), and apply to Bedrock only: a platform that
 *   serves another provider's models sets its own dates, so a Claude model called through Bedrock is
 *   judged by Bedrock's table, not Anthropic's, and one called through Vertex AI by Google's page
 *   for partner models;
 * - Azure OpenAI is left out: a call there names the deployment, which can serve any model.
 *
 * Models that hold no conversation (embeddings, images, speech, video) and the Live APIs, which
 * Shadowlap doesn't record, are left out.
 */

/** Where a model is served, as the table tells its dates apart: a provider's own API, or a platform that serves it. */
export type RetirementPlatform = 'anthropic' | 'openai' | 'gemini' | 'vertex' | 'bedrock';

export interface ModelRetirement {
  platform: RetirementPlatform;
  /** The model id exactly as the page lists it. */
  model: string;
  /** When it was deprecated: the announcement (Bedrock: the day it became Legacy). */
  deprecated?: string;
  /** The day requests to it stop working (YYYY-MM-DD), or null when the page says it is yet to be announced. */
  retires: string | null;
  /** The date is the earliest it may shut down, not a date set for it (the Gemini API). */
  earliest?: true;
  /** The Regions the date covers (Bedrock). */
  regions?: readonly string[];
  /** The replacement the page recommends, as it words it. */
  replacement?: string;
  /** The page the row comes from. */
  source: string;
}

/** The day the pages below were read: the table holds what they said then. */
export const RETIREMENTS_VERSION = '2026-10-19';

const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/model-deprecations';
/** Anthropic's page on manual thinking budgets: which models refuse them. */
const ANTHROPIC_THINKING = 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking';
const OPENAI = 'https://developers.openai.com/api/docs/deprecations';
const GEMINI = 'https://ai.google.dev/gemini-api/docs/deprecations';
const VERTEX = 'https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions';
const VERTEX_PARTNERS = 'https://cloud.google.com/vertex-ai/generative-ai/docs/deprecations/partner-models';
const BEDROCK = 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html';

/** Each platform's main page, every page its rows cite (`pages`), and how a report names the platform. */
export const RETIREMENT_SOURCES: Record<RetirementPlatform, { name: string; owner: string; url: string; pages: readonly string[] }> = {
  anthropic: { name: 'the Claude API', owner: 'Anthropic', url: ANTHROPIC, pages: [ANTHROPIC, ANTHROPIC_THINKING] },
  openai: { name: 'the OpenAI API', owner: 'OpenAI', url: OPENAI, pages: [OPENAI] },
  gemini: { name: 'the Gemini API', owner: 'Google', url: GEMINI, pages: [GEMINI] },
  vertex: { name: 'Vertex AI', owner: 'Google Cloud', url: VERTEX, pages: [VERTEX, VERTEX_PARTNERS] },
  bedrock: { name: 'Amazon Bedrock', owner: 'AWS', url: BEDROCK, pages: [BEDROCK] },
};

export const MODEL_RETIREMENTS: readonly ModelRetirement[] = [
  // ---- Anthropic: the Claude API (its model status table, and every announcement in its deprecation history) ----
  { platform: 'anthropic', model: 'claude-mythos-preview', deprecated: '2026-06-09', retires: null, source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-opus-4-1-20250805', deprecated: '2026-06-05', retires: '2026-08-05', replacement: 'claude-opus-4-8', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-opus-4-20250514', deprecated: '2026-04-14', retires: '2026-06-15', replacement: 'claude-opus-4-8', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-sonnet-4-5-20250929', deprecated: '2026-09-30', retires: '2026-11-30', replacement: 'claude-sonnet-5-5', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-sonnet-4-20250514', deprecated: '2026-04-14', retires: '2026-06-15', replacement: 'claude-sonnet-5-5', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-3-7-sonnet-20250219', deprecated: '2025-10-28', retires: '2026-02-19', replacement: 'claude-sonnet-5-5', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-3-5-haiku-20241022', deprecated: '2025-12-19', retires: '2026-02-19', replacement: 'claude-haiku-4-5-20251001', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-3-haiku-20240307', deprecated: '2026-02-19', retires: '2026-04-20', replacement: 'claude-haiku-4-5-20251001', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-3-5-sonnet-20240620', deprecated: '2025-08-13', retires: '2025-10-28', replacement: 'claude-sonnet-5-5', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-3-5-sonnet-20241022', deprecated: '2025-08-13', retires: '2025-10-28', replacement: 'claude-sonnet-5-5', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-3-opus-20240229', deprecated: '2025-06-30', retires: '2026-01-05', replacement: 'claude-opus-4-8', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-2.0', deprecated: '2025-01-21', retires: '2025-07-21', replacement: 'claude-opus-4-8', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-2.1', deprecated: '2025-01-21', retires: '2025-07-21', replacement: 'claude-opus-4-8', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-3-sonnet-20240229', deprecated: '2025-01-21', retires: '2025-07-21', replacement: 'claude-sonnet-5-5', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-1.0', deprecated: '2024-09-04', retires: '2024-11-06', replacement: 'claude-haiku-4-5-20251001', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-1.1', deprecated: '2024-09-04', retires: '2024-11-06', replacement: 'claude-haiku-4-5-20251001', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-1.2', deprecated: '2024-09-04', retires: '2024-11-06', replacement: 'claude-haiku-4-5-20251001', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-1.3', deprecated: '2024-09-04', retires: '2024-11-06', replacement: 'claude-haiku-4-5-20251001', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-instant-1.0', deprecated: '2024-09-04', retires: '2024-11-06', replacement: 'claude-haiku-4-5-20251001', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-instant-1.1', deprecated: '2024-09-04', retires: '2024-11-06', replacement: 'claude-haiku-4-5-20251001', source: ANTHROPIC },
  { platform: 'anthropic', model: 'claude-instant-1.2', deprecated: '2024-09-04', retires: '2024-11-06', replacement: 'claude-haiku-4-5-20251001', source: ANTHROPIC },
  // ---- OpenAI: the API (every announcement of a model a conversation is sent to; snapshots with the aliases the page names) ----
  { platform: 'openai', model: 'gpt-4o-2024-08-06', deprecated: '2026-10-14', retires: '2027-01-14', replacement: 'gpt-6-luna', source: OPENAI },
  { platform: 'openai', model: 'gpt-4o-2024-11-20', deprecated: '2026-10-14', retires: '2027-01-14', replacement: 'gpt-6-luna', source: OPENAI },
  { platform: 'openai', model: 'gpt-4o-mini-2024-07-18', deprecated: '2026-10-14', retires: '2027-01-14', replacement: 'gpt-6-luna', source: OPENAI },
  { platform: 'openai', model: 'gpt-4.1-2025-04-14', deprecated: '2026-10-14', retires: '2027-01-14', replacement: 'gpt-6-luna', source: OPENAI },
  { platform: 'openai', model: 'gpt-4.1-mini-2025-04-14', deprecated: '2026-10-14', retires: '2027-01-14', replacement: 'gpt-6-luna', source: OPENAI },
  { platform: 'openai', model: 'gpt-5.3-codex', deprecated: '2026-10-01', retires: '2027-04-01', replacement: 'gpt-6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-5.4-nano', deprecated: '2026-10-01', retires: '2027-04-01', replacement: 'gpt-6-luna', source: OPENAI },
  { platform: 'openai', model: 'gpt-5.1', deprecated: '2026-10-01', retires: '2027-04-01', replacement: 'gpt-6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-5-2025-08-07', deprecated: '2026-06-11', retires: '2026-12-11', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-5-mini-2025-08-07', deprecated: '2026-06-11', retires: '2026-12-11', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'gpt-5-nano-2025-08-07', deprecated: '2026-06-11', retires: '2026-12-11', replacement: 'gpt-5.6-luna', source: OPENAI },
  { platform: 'openai', model: 'gpt-5-pro-2025-10-06', deprecated: '2026-06-11', retires: '2026-12-11', replacement: 'gpt-5.6-sol (reasoning.mode: pro)', source: OPENAI },
  { platform: 'openai', model: 'o3-2025-04-16', deprecated: '2026-06-11', retires: '2026-12-11', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'o3-pro-2025-06-10', deprecated: '2026-06-11', retires: '2026-12-11', replacement: 'gpt-5.6-sol (reasoning.mode: pro)', source: OPENAI },
  { platform: 'openai', model: 'gpt-3.5-turbo-0125', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'gpt-3.5-turbo', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'gpt-3.5-turbo-completions', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-0613', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-4', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-0613-completions', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-completions', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-1106-preview', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-turbo', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-turbo-2024-04-09', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-turbo-completions', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-4.1-nano', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-luna', source: OPENAI },
  { platform: 'openai', model: 'gpt-4.1-nano-2025-04-14', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-luna', source: OPENAI },
  { platform: 'openai', model: 'gpt-4o-2024-05-13', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'o1-2024-12-17', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'o1', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'o1-pro-2025-03-19', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol (reasoning.mode: pro)', source: OPENAI },
  { platform: 'openai', model: 'o1-pro', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol (reasoning.mode: pro)', source: OPENAI },
  { platform: 'openai', model: 'o3-mini-2025-01-31', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'o3-mini', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'o4-mini-2025-04-16', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'o4-mini', deprecated: '2026-04-22', retires: '2026-10-23', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'gpt-5.4-cyber', deprecated: '2026-09-11', retires: '2026-10-01', replacement: 'The most capable cyber model available to you.', source: OPENAI },
  { platform: 'openai', model: 'gpt-5.2-chat-latest', deprecated: '2026-05-08', retires: '2026-08-10', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-5.3-chat-latest', deprecated: '2026-05-08', retires: '2026-08-10', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'computer-use-preview-2025-03-11', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'computer-use-preview', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'gpt-4o-mini-search-preview-2025-03-11', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'gpt-4o-search-preview-2025-03-11', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'gpt-5-chat-latest', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-5-codex', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-5.1-chat-latest', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-5.1-codex', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-5.1-codex-max', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-5.1-codex-mini', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'o3-deep-research-2025-06-26', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'o3-deep-research', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'o4-mini-deep-research-2025-06-26', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'o4-mini-deep-research', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'gpt-5.2-codex', deprecated: '2026-04-22', retires: '2026-07-23', replacement: 'gpt-5.6-sol', source: OPENAI },
  { platform: 'openai', model: 'chatgpt-4o-latest', deprecated: '2025-11-18', retires: '2026-02-17', replacement: 'gpt-5.1-chat-latest', source: OPENAI },
  { platform: 'openai', model: 'codex-mini-latest', deprecated: '2025-11-17', retires: '2026-02-12', replacement: 'gpt-5-codex-mini', source: OPENAI },
  { platform: 'openai', model: 'gpt-3.5-turbo-instruct', deprecated: '2025-09-26', retires: '2026-09-28', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'babbage-002', deprecated: '2025-09-26', retires: '2026-09-28', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'davinci-002', deprecated: '2025-09-26', retires: '2026-09-28', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'gpt-3.5-turbo-1106', deprecated: '2025-09-26', retires: '2026-09-28', replacement: 'gpt-5.6-terra', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-0314', deprecated: '2025-09-26', retires: '2026-03-26', replacement: 'gpt-5 or gpt-4.1', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-0125-preview', deprecated: '2025-09-26', retires: '2026-03-26', replacement: 'gpt-5 or gpt-4.1', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-turbo-preview', deprecated: '2025-09-26', retires: '2026-03-26', replacement: 'gpt-5 or gpt-4.1', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-turbo-preview-completions', deprecated: '2025-09-26', retires: '2026-03-26', replacement: 'gpt-5 or gpt-4.1', source: OPENAI },
  { platform: 'openai', model: 'o1-preview', deprecated: '2025-04-28', retires: '2025-07-28', replacement: 'o3', source: OPENAI },
  { platform: 'openai', model: 'o1-mini', deprecated: '2025-04-28', retires: '2025-10-27', replacement: 'o4-mini', source: OPENAI },
  { platform: 'openai', model: 'gpt-4.5-preview', deprecated: '2025-04-14', retires: '2025-07-14', replacement: 'gpt-4.1', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-32k', deprecated: '2024-06-06', retires: '2025-06-06', replacement: 'gpt-4o', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-32k-0613', deprecated: '2024-06-06', retires: '2025-06-06', replacement: 'gpt-4o', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-32k-0314', deprecated: '2024-06-06', retires: '2025-06-06', replacement: 'gpt-4o', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-vision-preview', deprecated: '2024-06-06', retires: '2024-12-06', replacement: 'gpt-4o', source: OPENAI },
  { platform: 'openai', model: 'gpt-4-1106-vision-preview', deprecated: '2024-06-06', retires: '2024-12-06', replacement: 'gpt-4o', source: OPENAI },
  { platform: 'openai', model: 'gpt-3.5-turbo-0613', deprecated: '2023-11-06', retires: '2024-09-13', replacement: 'gpt-3.5-turbo', source: OPENAI },
  { platform: 'openai', model: 'gpt-3.5-turbo-16k-0613', deprecated: '2023-11-06', retires: '2024-09-13', replacement: 'gpt-3.5-turbo', source: OPENAI },
  { platform: 'openai', model: 'text-ada-001', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'gpt-3.5-turbo-instruct', source: OPENAI },
  { platform: 'openai', model: 'text-babbage-001', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'gpt-3.5-turbo-instruct', source: OPENAI },
  { platform: 'openai', model: 'text-curie-001', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'gpt-3.5-turbo-instruct', source: OPENAI },
  { platform: 'openai', model: 'text-davinci-001', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'gpt-3.5-turbo-instruct', source: OPENAI },
  { platform: 'openai', model: 'text-davinci-002', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'gpt-3.5-turbo-instruct', source: OPENAI },
  { platform: 'openai', model: 'text-davinci-003', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'gpt-3.5-turbo-instruct', source: OPENAI },
  { platform: 'openai', model: 'ada', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'babbage-002', source: OPENAI },
  { platform: 'openai', model: 'babbage', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'babbage-002', source: OPENAI },
  { platform: 'openai', model: 'curie', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'davinci-002', source: OPENAI },
  { platform: 'openai', model: 'davinci', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'davinci-002', source: OPENAI },
  { platform: 'openai', model: 'code-davinci-002', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'gpt-3.5-turbo-instruct', source: OPENAI },
  { platform: 'openai', model: 'text-davinci-edit-001', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'gpt-4o', source: OPENAI },
  { platform: 'openai', model: 'code-davinci-edit-001', deprecated: '2023-07-06', retires: '2024-01-04', replacement: 'gpt-4o', source: OPENAI },
  { platform: 'openai', model: 'gpt-3.5-turbo-0301', deprecated: '2023-06-13', retires: '2024-09-13', replacement: 'gpt-3.5-turbo', source: OPENAI },
  { platform: 'openai', model: 'code-davinci-002', deprecated: '2023-03-20', retires: '2023-03-23', replacement: 'gpt-4o', source: OPENAI },
  { platform: 'openai', model: 'code-davinci-001', deprecated: '2023-03-20', retires: '2023-03-23', replacement: 'gpt-4o', source: OPENAI },
  { platform: 'openai', model: 'code-cushman-002', deprecated: '2023-03-20', retires: '2023-03-23', replacement: 'gpt-4o', source: OPENAI },
  { platform: 'openai', model: 'code-cushman-001', deprecated: '2023-03-20', retires: '2023-03-23', replacement: 'gpt-4o', source: OPENAI },
  // ---- Google: the Gemini API (Gemini 3, 2.5 and 2.0; each date is the earliest it may shut down) ----
  { platform: 'gemini', model: 'gemini-3.1-flash-lite', retires: '2027-05-07', earliest: true, replacement: 'gemini-3.5-flash-lite', source: GEMINI },
  { platform: 'gemini', model: 'gemini-3-pro-preview', retires: '2026-03-09', earliest: true, replacement: 'gemini-3.1-pro-preview', source: GEMINI },
  { platform: 'gemini', model: 'gemini-3.1-flash-lite-preview', retires: '2026-05-25', earliest: true, replacement: 'gemini-3.1-flash-lite', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.5-computer-use-preview-10-2025', retires: '2026-07-28', earliest: true, replacement: 'gemini-3.8-flash', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.5-pro-preview-03-25', retires: '2025-12-02', earliest: true, replacement: 'gemini-3.1-pro-preview', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.5-pro-preview-05-06', retires: '2025-12-02', earliest: true, replacement: 'gemini-3.1-pro-preview', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.5-pro-preview-06-05', retires: '2025-12-02', earliest: true, replacement: 'gemini-3.1-pro-preview', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.5-flash-lite-preview-09-2025', retires: '2026-03-31', earliest: true, replacement: 'gemini-3.1-flash-lite', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.5-flash-preview-05-20', retires: '2025-11-18', earliest: true, replacement: 'gemini-3.6-flash', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.5-flash-preview-09-25', retires: '2026-02-17', earliest: true, replacement: 'gemini-3.6-flash', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.0-flash', retires: '2026-06-01', earliest: true, replacement: 'gemini-3.6-flash', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.0-flash-001', retires: '2026-06-01', earliest: true, replacement: 'gemini-3.6-flash', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.0-flash-lite', retires: '2026-06-01', earliest: true, replacement: 'gemini-3.1-flash-lite', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.0-flash-lite-001', retires: '2026-06-01', earliest: true, replacement: 'gemini-3.1-flash-lite', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.0-flash-lite-preview', retires: '2025-12-09', earliest: true, replacement: 'gemini-2.5-flash-lite', source: GEMINI },
  { platform: 'gemini', model: 'gemini-2.0-flash-lite-preview-02-05', retires: '2025-12-09', earliest: true, replacement: 'gemini-2.5-flash-lite', source: GEMINI },
  // ---- Google Cloud: Gemini on Vertex AI (models with a set retirement date, short-term ones, and retired
  // ones; an "or later" date sets none). A stable version the page lists by its model's name
  // (`gemini-2.0-flash-001`) is that model: see `rowsFor` ----
  { platform: 'vertex', model: 'gemini-2.5-pro', retires: '2026-10-20', replacement: 'gemini-3.8-flash or gemini-3.5-flash', source: VERTEX },
  { platform: 'vertex', model: 'gemini-2.5-flash', retires: '2026-10-20', replacement: 'gemini-3.8-flash or gemini-3.5-flash-lite or gemini-3.1-flash-lite', source: VERTEX },
  { platform: 'vertex', model: 'gemini-2.5-flash-lite', retires: '2026-10-20', replacement: 'gemini-3.8-flash or gemini-3.1-flash-lite or Gemma 4', source: VERTEX },
  { platform: 'vertex', model: 'gemini-3.7-flash', retires: '2027-01-28', replacement: 'gemini-3.8-flash', source: VERTEX },
  { platform: 'vertex', model: 'gemini-3.6-flash', retires: '2026-11-19', replacement: 'gemini-3.8-flash', source: VERTEX },
  { platform: 'vertex', model: 'gemini-2.0-flash', retires: '2026-06-01', replacement: 'gemini-3.1-flash-lite', source: VERTEX },
  { platform: 'vertex', model: 'gemini-2.0-flash-lite', retires: '2026-06-01', replacement: 'gemini-3.1-flash-lite', source: VERTEX },
  { platform: 'vertex', model: 'gemini-1.5-pro-001', retires: '2025-05-24', replacement: 'gemini-2.5-flash', source: VERTEX },
  { platform: 'vertex', model: 'gemini-1.5-pro-002', retires: '2025-09-24', replacement: 'gemini-2.5-flash', source: VERTEX },
  { platform: 'vertex', model: 'gemini-1.5-flash-001', retires: '2025-05-24', replacement: 'gemini-2.5-flash-lite', source: VERTEX },
  { platform: 'vertex', model: 'gemini-1.5-flash-002', retires: '2025-09-24', replacement: 'gemini-2.5-flash-lite', source: VERTEX },
  { platform: 'vertex', model: 'gemini-1.0-pro-001', retires: '2025-04-21', replacement: 'gemini-2.5-flash', source: VERTEX },
  { platform: 'vertex', model: 'gemini-1.0-pro-002', retires: '2025-04-21', replacement: 'gemini-2.5-flash', source: VERTEX },
  { platform: 'vertex', model: 'gemini-1.0-pro-vision-001', retires: '2025-04-21', replacement: 'gemini-2.5-flash', source: VERTEX },
  { platform: 'vertex', model: 'text-bison', retires: '2025-04-21', replacement: 'gemini-2.5-flash-lite', source: VERTEX },
  { platform: 'vertex', model: 'chat-bison', retires: '2025-04-21', replacement: 'gemini-2.5-flash-lite', source: VERTEX },
  { platform: 'vertex', model: 'code-gecko', retires: '2025-04-21', replacement: 'gemini-2.5-flash-lite', source: VERTEX },
  // ---- Google Cloud: partner models on Vertex AI (Claude and Jamba), by the model ids the page names; a
  // call names a Claude version after `@` (`claude-3-7-sonnet@20250219`). The page names no replacements ----
  { platform: 'vertex', model: 'claude-3-haiku', deprecated: '2026-02-23', retires: '2026-08-23', source: VERTEX_PARTNERS },
  { platform: 'vertex', model: 'claude-3-5-haiku', deprecated: '2026-01-05', retires: '2026-07-05', source: VERTEX_PARTNERS },
  { platform: 'vertex', model: 'claude-3-7-sonnet', deprecated: '2025-11-11', retires: '2026-05-11', source: VERTEX_PARTNERS },
  { platform: 'vertex', model: 'claude-3-5-sonnet-v2', deprecated: '2025-08-20', retires: '2026-02-19', source: VERTEX_PARTNERS },
  { platform: 'vertex', model: 'claude-3-5-sonnet', deprecated: '2025-08-20', retires: '2026-02-19', source: VERTEX_PARTNERS },
  { platform: 'vertex', model: 'jamba-1.5-large', deprecated: '2025-08-27', retires: '2026-02-27', source: VERTEX_PARTNERS },
  { platform: 'vertex', model: 'jamba-1.5-mini', deprecated: '2025-08-27', retires: '2026-02-27', source: VERTEX_PARTNERS },
  { platform: 'vertex', model: 'claude-3-opus', deprecated: '2025-06-30', retires: '2025-08-01', source: VERTEX_PARTNERS },
  // ---- Amazon Bedrock: models launched before September 7, 2026 (text models), by the Regions each date covers ----
  { platform: 'bedrock', model: 'ai21.jamba-1-5-large-v1:0', deprecated: '2026-05-26', retires: '2026-11-26', regions: ['us-east-1'], source: BEDROCK },
  { platform: 'bedrock', model: 'ai21.jamba-1-5-mini-v1:0', deprecated: '2026-05-26', retires: '2026-11-26', regions: ['us-east-1'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-3-haiku-20240307-v1:0', deprecated: '2026-10-10', retires: '2026-11-13', regions: ['ap-northeast-2', 'ap-south-1', 'ap-southeast-1'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-3-haiku-20240307-v1:0', deprecated: '2026-10-13', retires: '2026-11-13', regions: ['eu-central-2', 'sa-east-1'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-3-haiku-20240307-v1:0', deprecated: '2026-10-15', retires: '2026-11-13', regions: ['ca-central-1'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-3-sonnet-20240229-v1:0', deprecated: '2026-10-10', retires: '2026-11-13', regions: ['ap-south-1', 'ap-southeast-1', 'eu-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-3-sonnet-20240229-v1:0', deprecated: '2026-10-13', retires: '2026-11-13', regions: ['sa-east-1'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-3-sonnet-20240229-v1:0', deprecated: '2026-10-15', retires: '2026-11-13', regions: ['ca-central-1'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-3-5-sonnet-20240620-v1:0', deprecated: '2026-10-10', retires: '2026-11-13', regions: ['ap-northeast-2', 'ap-south-1', 'ap-southeast-1'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-3-5-sonnet-20241022-v2:0', deprecated: '2026-10-10', retires: '2026-11-13', regions: ['ap-northeast-2', 'ap-south-1', 'ap-southeast-1'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-3-7-sonnet-20250219-v1:0', deprecated: '2026-10-10', retires: '2026-11-13', regions: ['ap-south-1', 'eu-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-sonnet-4-5-20250929-v1:0', deprecated: '2026-10-08', retires: '2027-04-08', regions: ['af-south-1', 'ap-east-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7', 'ca-central-1', 'ca-west-1', 'eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'il-central-1', 'mx-central-1', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-opus-4-1-20250805-v1:0', deprecated: '2026-07-08', retires: '2027-01-08', regions: ['us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'deepseek.r1-v1:0', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'deepseek.v3-v1:0', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-3', 'eu-north-1', 'eu-west-2', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'deepseek.v3.1', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-3', 'eu-north-1', 'eu-west-2', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'google.gemma-3-12b-it', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'google.gemma-3-27b-it', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'google.gemma-3-4b-it', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama3-70b-instruct-v1:0', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-south-1', 'ca-central-1', 'eu-west-2', 'us-east-1', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama3-8b-instruct-v1:0', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-south-1', 'ca-central-1', 'eu-west-2', 'us-east-1', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama3-1-70b-instruct-v1:0', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama3-1-8b-instruct-v1:0', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama3-3-70b-instruct-v1:0', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama4-maverick-17b-instruct-v1:0', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama4-scout-17b-instruct-v1:0', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'minimax.minimax-m2', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'minimax.minimax-m2.1', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'mistral.devstral-2-123b', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'mistral.mistral-7b-instruct-v0:2', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-south-1', 'ap-southeast-2', 'ca-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'sa-east-1', 'us-east-1', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'mistral.mixtral-8x7b-instruct-v0:1', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-south-1', 'ap-southeast-2', 'ca-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'sa-east-1', 'us-east-1', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'moonshot.kimi-k2-thinking', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'moonshotai.kimi-k2-thinking', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'nvidia.nemotron-nano-12b-v2', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'nvidia.nemotron-nano-9b-v2', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'qwen.qwen3-coder-30b-a3b-v1:0', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'qwen.qwen3-coder-30b-a3b-instruct', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'qwen.qwen3-coder-480b-a35b-v1:0', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-3', 'eu-north-1', 'eu-west-2', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'qwen.qwen3-coder-480b-a35b-instruct', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-3', 'eu-north-1', 'eu-west-2', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'writer.palmyra-x4-v1:0', deprecated: '2026-09-09', retires: '2027-03-09', regions: ['us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'writer.palmyra-x5-v1:0', deprecated: '2026-09-21', retires: '2027-03-21', regions: ['us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'zai.glm-4.7', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-3', 'eu-north-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'zai.glm-4.7-flash', deprecated: '2026-09-30', retires: '2027-03-30', regions: ['ap-northeast-1', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-3-haiku-20240307-v1:0', deprecated: '2026-03-10', retires: '2026-09-10', regions: ['ap-northeast-1', 'ap-southeast-2', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-3-haiku-20240307-v1:0', deprecated: '2026-03-10', retires: '2026-09-10', regions: ['us-gov-east-1', 'us-gov-west-1'], source: BEDROCK },
  { platform: 'bedrock', model: 'anthropic.claude-sonnet-4-20250514-v1:0', deprecated: '2026-04-14', retires: '2026-10-14', regions: ['ap-northeast-1', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-3', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ap-east-2', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-7', 'il-central-1'], source: BEDROCK },
  { platform: 'bedrock', model: 'cohere.command-r-v1:0', deprecated: '2026-02-19', retires: '2026-08-19', regions: ['us-east-1', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'cohere.command-r-plus-v1:0', deprecated: '2026-02-19', retires: '2026-08-19', regions: ['us-east-1', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama3-1-405b-instruct-v1:0', deprecated: '2026-01-07', retires: '2026-07-07', regions: ['us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama3-2-11b-instruct-v1:0', deprecated: '2026-01-07', retires: '2026-07-07', regions: ['us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama3-2-1b-instruct-v1:0', deprecated: '2026-01-07', retires: '2026-07-07', regions: ['eu-central-1', 'eu-west-1', 'eu-west-3', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama3-2-3b-instruct-v1:0', deprecated: '2026-01-07', retires: '2026-07-07', regions: ['eu-central-1', 'eu-west-1', 'eu-west-3', 'us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
  { platform: 'bedrock', model: 'meta.llama3-2-90b-instruct-v1:0', deprecated: '2026-01-07', retires: '2026-07-07', regions: ['us-east-1', 'us-east-2', 'us-west-2'], source: BEDROCK },
];

/**
 * Request fields a provider stops accepting on its newer models, from its own pages: what a model
 * switch may need besides the model's name. `models` are the model ids the page's words cover.
 * Anthropic's rules are about Claude models wherever they are served: they apply to a Messages API
 * body on the Claude API, Amazon Bedrock and Vertex AI alike.
 */
export interface FieldRetirement {
  platform: RetirementPlatform;
  fields: readonly string[];
  /** The models it applies to, by id (an alias or a dated snapshot of one starts with it). */
  models: readonly string[];
  /** Which models, in the page's words. */
  appliesTo: string;
  /** What the provider does with such a request, in the page's words. */
  behavior: string;
  /** The same as a clause a report can follow "where" with. */
  says: string;
  /** What the page recommends instead. */
  instead: string;
  /** The value the field may still take (its default), when the page allows one: the request gets it in place of its own. */
  allowed?: Record<string, unknown>;
  /**
   * The rule covers a field only when its value is an object carrying these entries (`thinking` whose
   * `type` is `enabled`); without it, any value but the allowed one.
   */
  when?: Record<string, Record<string, unknown>>;
  source: string;
}

/** Claude 4.7 and later, as Anthropic's model status table lists them. */
const CLAUDE_4_7_AND_LATER = ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5', 'claude-fable-5', 'claude-mythos-5'];

export const FIELD_RETIREMENTS: readonly FieldRetirement[] = [
  {
    platform: 'anthropic',
    fields: ['temperature', 'top_p', 'top_k'],
    models: [...CLAUDE_4_7_AND_LATER, 'claude-mythos-preview'],
    appliesTo: 'Claude 4.7 and later models, and Claude Mythos Preview',
    behavior: 'Returns a 400 error when set to a non-default value',
    says: 'a non-default temperature, top_p or top_k returns a 400 error',
    instead: 'Omit and use prompting to guide model behavior',
    // The Messages API's documented default.
    allowed: { temperature: 1 },
    source: ANTHROPIC,
  },
  {
    platform: 'anthropic',
    fields: ['thinking'],
    // Claude Mythos Preview supports both thinking modes, the page says.
    models: CLAUDE_4_7_AND_LATER,
    appliesTo: 'Claude 4.7 and later models',
    behavior: 'Claude 4.7 and later models do not support it and reject requests that use it, returning a 400 error',
    says: 'extended thinking (thinking.type "enabled", with budget_tokens) is not supported and a request that uses it returns a 400 error',
    instead: 'Remove budget_tokens, set thinking: {type: "adaptive"}, and control reasoning depth with output_config: {effort: ...} instead of a token budget',
    allowed: { thinking: { type: 'adaptive' } },
    when: { thinking: { type: 'enabled' } },
    source: ANTHROPIC_THINKING,
  },
];

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Which platform's dates apply to a call, by the provider Shadowlap recorded it through. */
export function retirementPlatform(provider: string | null | undefined): RetirementPlatform | null {
  return provider === 'anthropic' || provider === 'openai' || provider === 'gemini' || provider === 'vertex' || provider === 'bedrock' ? provider : null;
}

/**
 * A recorded model id as the table names it: Gemini's `models/` prefix and Vertex AI's publisher path
 * left out, and for Bedrock an inference profile's Region prefix (`us.`, `eu.`, `global.`…) and an
 * ARN's path, keeping the Region an ARN names.
 */
export function tableModel(platform: RetirementPlatform, model: string): { model: string; region: string | null } {
  let m = model.trim();
  let region: string | null = null;
  if (platform === 'bedrock') {
    const arn = /^arn:aws[\w-]*:bedrock:([a-z0-9-]*):[^:]*:(?:foundation-model|inference-profile|application-inference-profile)\/(.+)$/.exec(m);
    if (arn) {
      region = arn[1] || null;
      m = arn[2]!;
    }
    m = m.replace(/^(us|eu|apac|jp|au|ca|us-gov|global)\./, '');
  }
  if (platform === 'gemini' || platform === 'vertex') m = m.replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/[^/]+\/models\//, '').replace(/^models\//, '');
  return { model: m, region };
}

/** What a report says about a model that retires: the row, and the words. */
export interface RetirementNotice {
  provider: string;
  /** The model as the recording names it. */
  model: string;
  platform: RetirementPlatform;
  /** The row's model id, when the recording names an alias of it (an Anthropic `claude-…-latest`). */
  matched: string;
  deprecated: string | null;
  retires: string | null;
  earliest: boolean;
  regions: readonly string[] | null;
  replacement: string | null;
  /** retired: its date has passed; retiring: it is set; deprecated: no date yet. */
  state: 'retired' | 'retiring' | 'deprecated';
  /** Days until it retires (negative once retired), or null without a date. */
  days: number | null;
  source: string;
  text: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `2026-11-30` as a report writes it: `November 30, 2026`. */
export function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

function rowsFor(platform: RetirementPlatform, model: string): ModelRetirement[] {
  const exact = MODEL_RETIREMENTS.filter((r) => r.platform === platform && r.model === model);
  if (exact.length) return exact;
  if (platform === 'vertex') {
    // A version of a model Google's pages list by name: a Claude version after `@`
    // (`claude-3-7-sonnet@20250219`), a Gemini stable version (`gemini-2.0-flash-001`).
    const named = model.replace(/@[^@]+$/, '').replace(/^(gemini-.+)-\d{3}$/, '$1');
    return named === model ? [] : MODEL_RETIREMENTS.filter((r) => r.platform === 'vertex' && r.model === named);
  }
  if (platform !== 'anthropic') return [];
  // An Anthropic alias (`claude-sonnet-4-5`, `claude-3-7-sonnet-latest`) names the one dated snapshot it points to.
  const base = model.replace(/-latest$/, '');
  const dated = MODEL_RETIREMENTS.filter((r) => r.platform === 'anthropic' && new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}$`).test(r.model));
  return dated.length === 1 ? dated : [];
}

/**
 * Whether a model a call was made with retires, by the table, as of `now`; null when the table has
 * nothing on it. `region` picks Bedrock's row for that Region, when known.
 */
export function retirementOf(provider: string | null | undefined, model: string | null | undefined, o: { now?: number; region?: string | null } = {}): RetirementNotice | null {
  const platform = retirementPlatform(provider);
  if (!platform || !model) return null;
  const { model: id, region: fromArn } = tableModel(platform, model);
  let rows = rowsFor(platform, id);
  if (!rows.length) return null;
  const region = o.region ?? fromArn;
  if (region && rows.some((r) => r.regions)) {
    const here = rows.filter((r) => r.regions?.includes(region));
    if (!here.length) return null;
    rows = here;
  }
  const now = o.now ?? Date.now();
  // The date that matters first: the soonest still to come, else the latest gone by, else none set.
  const future = rows.filter((r) => r.retires && dayMs(r.retires) > now).sort((a, b) => dayMs(a.retires!) - dayMs(b.retires!));
  const past = rows.filter((r) => r.retires && dayMs(r.retires) <= now).sort((a, b) => dayMs(b.retires!) - dayMs(a.retires!));
  const row = future[0] ?? past[0] ?? rows[0]!;
  const days = row.retires ? Math.ceil((dayMs(row.retires) - now) / 86_400_000) : null;
  const state = !row.retires ? 'deprecated' : days! <= 0 ? 'retired' : 'retiring';
  const where = RETIREMENT_SOURCES[platform];
  const named = row.model === id ? model : `${model} (${row.model})`;
  // Bedrock: the Regions of every row with that date, and the other dates with theirs.
  const regionsOn = (day: string | null) => [...new Set(rows.filter((r) => r.retires === day).flatMap((r) => r.regions ?? []))];
  const regions = row.regions ? regionsOn(row.retires) : null;
  const otherDays = [...new Set(rows.map((r) => r.retires).filter((d): d is string => !!d && d !== row.retires))].sort();
  const count = (n: number) => (n === 1 ? '1 Region' : `${n} Regions`);
  const inRegions = regions
    ? ` in ${regions.length === 1 ? regions[0] : count(regions.length)}${otherDays.length ? ` (${otherDays.map((d) => `${dayMs(d) <= now ? 'it reached it on' : 'and on'} ${longDate(d)} in ${count(regionsOn(d).length)}`).join(', ')})` : ''}`
    : '';
  const instead = row.replacement ? `; ${where.owner} recommends ${row.replacement}` : '';
  const text =
    state === 'deprecated'
      ? `${named} is deprecated on ${where.name}${row.deprecated ? ` since ${longDate(row.deprecated)}` : ''}, its retirement date to be announced${instead}`
      : state === 'retired'
        ? `${named} ${row.earliest ? 'may have shut down' : 'was retired'} on ${where.name} on ${longDate(row.retires!)}${inRegions}${row.earliest ? '' : ': requests to it fail'}${instead}`
        : row.earliest
          ? `${named} may shut down on ${where.name} from ${longDate(row.retires!)}, in ${days} day${days === 1 ? '' : 's'}: the earliest date ${where.owner} gives${instead}`
          : `${named} retires on ${where.name} on ${longDate(row.retires!)}${inRegions}, in ${days} day${days === 1 ? '' : 's'}${instead}`;
  return { provider: provider!, model, platform, matched: row.model, deprecated: row.deprecated ?? null, retires: row.retires, earliest: row.earliest === true, regions, replacement: row.replacement ?? null, state, days, source: row.source, text };
}

/** Every model among these that retires, each once, the soonest first. */
export function retirementsOf(models: Iterable<{ provider: string | null | undefined; model: string | null | undefined }>, o: { now?: number } = {}): RetirementNotice[] {
  const seen = new Map<string, RetirementNotice>();
  for (const { provider, model } of models) {
    const key = `${provider ?? ''}\u0000${model ?? ''}`;
    if (seen.has(key)) continue;
    const n = retirementOf(provider, model, o);
    if (n) seen.set(key, n);
  }
  const order = (n: RetirementNotice) => (n.days === null ? Number.MAX_SAFE_INTEGER : n.days);
  return [...seen.values()].sort((a, b) => order(a) - order(b) || a.model.localeCompare(b.model));
}

/**
 * The Claude model a Messages API body is sent to, as Anthropic names it, wherever it is served:
 * Bedrock's `anthropic.` prefix and version suffix (`anthropic.claude-sonnet-4-5-20250929-v1:0`) and
 * Vertex AI's `@` version left out. Null for a body that isn't a Messages API request to Claude.
 */
function claudeModel(provider: string | null | undefined, model: string, body: Record<string, unknown>): string | null {
  const platform = retirementPlatform(provider);
  if (platform === 'anthropic') return tableModel(platform, model).model;
  // On Bedrock and Vertex AI a Messages API body names its version; Converse and Gemini's don't.
  if ((platform === 'bedrock' || platform === 'vertex') && body.anthropic_version !== undefined) {
    const id = tableModel(platform, model).model.replace(/^anthropic\./, '').replace(/-v\d+(?::\d+)?$/, '').replace(/@[^@]+$/, '');
    return id.startsWith('claude-') ? id : null;
  }
  return null;
}

const holds = (value: unknown, entries: Record<string, unknown>) => typeof value === 'object' && value !== null && Object.entries(entries).every(([k, v]) => (value as Record<string, unknown>)[k] === v);

/** Request fields the target model refuses, by the table: those a request sets, with what the page says. */
export function retiredFields(provider: string | null | undefined, model: string, body: unknown): Array<{ field: string; value: unknown; rule: FieldRetirement }> {
  const platform = retirementPlatform(provider);
  if (!platform || typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  const fields = body as Record<string, unknown>;
  const out: Array<{ field: string; value: unknown; rule: FieldRetirement }> = [];
  for (const rule of FIELD_RETIREMENTS) {
    const id = rule.platform === 'anthropic' ? claudeModel(provider, model, fields) : rule.platform === platform ? tableModel(platform, model).model : null;
    if (id === null || !rule.models.some((m) => id === m || id.startsWith(`${m}-`))) continue;
    for (const field of rule.fields) {
      const value = fields[field];
      if (value === undefined || (rule.allowed && field in rule.allowed && canonicalize(rule.allowed[field]) === canonicalize(value))) continue;
      if (rule.when?.[field] && !holds(value, rule.when[field]!)) continue;
      out.push({ field, value, rule });
    }
  }
  return out;
}

/** The table's own checks: every row dated and sourced, for its test. */
export function retirementTableProblems(): string[] {
  const problems: string[] = [];
  const pages = new Set(Object.values(RETIREMENT_SOURCES).flatMap((s) => s.pages));
  for (const f of FIELD_RETIREMENTS) if (!pages.has(f.source)) problems.push(`the ${f.fields.join(', ')} rule: its source is not one of the platforms' pages`);
  for (const r of MODEL_RETIREMENTS) {
    const at = `${r.platform} ${r.model}`;
    if (!pages.has(r.source)) problems.push(`${at}: its source is not one of the platforms' pages`);
    if (r.retires !== null && !isDate(r.retires)) problems.push(`${at}: retires is not a date`);
    if (r.deprecated !== undefined && !isDate(r.deprecated)) problems.push(`${at}: deprecated is not a date`);
    if (r.deprecated && r.retires && r.deprecated > r.retires) problems.push(`${at}: deprecated after it retires`);
    if (r.platform === 'bedrock' && !r.regions?.length) problems.push(`${at}: a Bedrock date needs its Regions`);
  }
  return problems;
}
