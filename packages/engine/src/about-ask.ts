import { firstSentence, type RunAsk } from './about.js';
import { normalizeConversation, type TurnBlock } from './conversation.js';
import { conversationRequest, runConversations, type RunConversations } from './conversations.js';
import { isReservedScope } from './judge-scope.js';
import { loadApiRequest } from './manifest.js';
import type { Store, StoreOf } from './store.js';
import type { CallRecord } from './types.js';

/**
 * What a recording's about line quotes: the first thing its user asked, read from the first request
 * of the agent under test. In a run of several agents (model calls made in more than one scope),
 * the agent under test is the first that calls tools: a model playing the user calls none, and its
 * first message is only its instructions ("Start the conversation with the support agent"). A run
 * whose agent under test held several conversations (an overnight batch of tickets) is a batch,
 * which reads by its input: its first message is only its first item.
 */

const scopeOf = (c: Pick<CallRecord, 'meta'>): string => (typeof c.meta.scope === 'string' ? c.meta.scope : '');

/** The text of a user turn: its text blocks, joined; a tool's result or an image says nothing the user asked. */
function userText(blocks: readonly TurnBlock[]): string {
  return blocks
    .filter((b): b is Extract<TurnBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
}

/** The first user message a model request holds, as text, or null. */
function firstUserMessage(store: StoreOf<'recording'>, call: CallRecord): string | null {
  if (!call.requestRef) return null;
  let body: unknown;
  try {
    body = loadApiRequest(store, call.requestRef);
  } catch {
    return null;
  }
  const conversation = normalizeConversation(body);
  if (!conversation) return null;
  for (const turn of conversation.turns) {
    if (turn.role !== 'user') continue;
    const text = userText(turn.blocks);
    if (text) return text;
  }
  return null;
}

export interface RunAskOptions {
  /**
   * Count the agent's conversations, to tell a batch, which reads every model request of the run
   * once: for a run that has ended. A run still recording is read by its first request alone. The
   * run's conversations already worked out (a run page's analysis has them) are taken as they are.
   */
  conversations?: boolean | RunConversations;
}

/**
 * The first thing a run's user asked (its first sentence), whether that is what the agent under
 * test was asked in a run of several agents, and whether the agent held several conversations (a
 * batch). Null for a run with no model call that carries a user message.
 */
export function runAsk(store: Store, calls: readonly CallRecord[], options: RunAskOptions = {}): RunAsk | null {
  const sorted = [...calls].sort((a, b) => a.callNo - b.callNo);
  const models = sorted.filter((c) => conversationRequest(c) && !isReservedScope(c.meta.scope));
  if (!models.length) return null;
  const scopes = new Set(models.map(scopeOf));
  const several = scopes.size > 1;
  let scope = scopeOf(models[0]!);
  if (several) {
    const acting = new Set(sorted.filter((c) => c.kind === 'tool' && !isReservedScope(c.meta.scope)).map(scopeOf));
    const first = models.find((c) => acting.has(scopeOf(c)));
    if (first) scope = scopeOf(first);
  }
  const own = models.filter((c) => scopeOf(c) === scope);
  let text: string | null = null;
  for (const c of own.slice(0, 5)) {
    text = firstUserMessage(store, c);
    if (text) break;
  }
  if (!text) return null;
  let batch = false;
  if (options.conversations && own.length > 1) {
    try {
      const spans = (options.conversations === true ? runConversations(store, sorted) : options.conversations).conversations.filter((s) => (s.scope ?? '') === scope);
      batch = spans.length > 1;
    } catch {
      batch = false;
    }
  }
  return { text: firstSentence(text), agent: several, batch };
}
