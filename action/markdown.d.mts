// Types for markdown.mjs, which the action runs as plain JavaScript.

/** Text from a run, a model or a tool, safe in the Markdown GitHub renders: it shows as it is and makes nothing else. */
export function markdownText(text: string): string;
/** Text as a code span, which its own backticks can't end. */
export function markdownCode(text: string, options?: { cell?: boolean }): string;
/** Lines in a fenced code block, which no line inside can close. */
export function markdownFence(text: string, lang?: string): string;
