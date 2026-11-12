/*
 * The words for where a model call went, in a module of its own: the inspector says them on the run's
 * page, and Provenance and the notes (notes.ts, a part of its own) say them too.
 */

/** The host a model call went to (`meta.via`), in words: a host the config declares, in its format, or one built in by name. */
export function viaWords(via: string, provider: string | null): string {
  if (via === 'foundry') return 'Claude on Microsoft Foundry';
  if (via === 'bedrock-mantle') return 'OpenAI’s API on Amazon Bedrock';
  const format = provider === 'openai' ? 'OpenAI' : provider === 'anthropic' ? 'Anthropic' : provider === 'gemini' ? 'Gemini' : provider;
  return format ? `${via}, a host your config declares, in ${format}’s format` : `${via}, a host your config declares`;
}
