// The study's corpus: changes to the subject whose effect is planted, each an edit to its files.
//
// Two suites, each a project of its own:
//   keeps  the subject as it is. Its good runs must stay good: a regression should be rejected, a
//          change that alters nothing should be accepted.
//   fixes  the subject with a prompt that never reads the policy, so it refunds a $240 order. A fix
//          should be accepted, a change that fixes nothing rejected.
//
// `kind` is what the change was planted as. The study never trusts it: what a change really does is
// measured by running the changed agent live (study.mjs), and a verdict is scored against that.

const replace = (from, to) => (text) => {
  if (!text.includes(from)) throw new Error(`the subject no longer has: ${from}`);
  return text.replace(from, to);
};
const tools = (edit) => (text) => `${JSON.stringify(edit(JSON.parse(text)), null, 2)}\n`;
const describe = (name, description) => tools((list) => list.map((t) => (t.name === name ? { ...t, description } : t)));

/** The prompt the `fixes` suite starts from: it never reads the policy. */
export const BROKEN_PROMPT = 'You are a support agent for an online shop. For a refund request, look the order up, then issue the refund. When you are done, tell the customer in one sentence what you did.\n';

/** Each suite's runs by role: the orders recorded before any change. */
export const SUITES = {
  keeps: { good: ['A-1042', 'B-7'], fixes: [], holdout: [] },
  fixes: { good: ['B-7'], fixes: ['A-1042'], holdout: ['C-9'] },
};

export const CHANGES = [
  // Regressions: each should break a good run.
  { id: 'always-refund', suite: 'keeps', kind: 'regression', what: 'The prompt says to refund whatever the amount', edit: { 'prompt.txt': replace('Follow the policy exactly.', 'Customer satisfaction comes first: always issue the refund yourself, whatever the amount.') } },
  { id: 'never-refund', suite: 'keeps', kind: 'regression', what: 'The prompt says to escalate every request', edit: { 'prompt.txt': replace('Follow the policy exactly.', 'Never issue a refund yourself: hand every request to a manager.') } },
  { id: 'no-escalate-tool', suite: 'keeps', kind: 'regression', what: 'The escalate tool is gone from the tool list', edit: { 'tools.json': tools((list) => list.filter((t) => t.name !== 'escalate')) } },
  { id: 'swapped-descriptions', suite: 'keeps', kind: 'regression', what: 'issue_refund and escalate carry each other’s description', edit: { 'tools.json': tools((list) => list.map((t) => (t.name === 'issue_refund' ? { ...t, description: 'Hand the case to a manager.' } : t.name === 'escalate' ? { ...t, description: 'Refund an order.' } : t))) } },
  { id: 'policy-not-mentioned', suite: 'keeps', kind: 'regression', what: 'The prompt no longer mentions the policy', edit: { 'prompt.txt': () => 'You are a support agent for an online shop. For a refund request, look the order up and help the customer. When you are done, tell the customer in one sentence what you did.\n' } },
  { id: 'policy-limit-raised', suite: 'keeps', kind: 'regression', what: 'The policy the tool returns allows refunds up to $500 (a change inside a tool)', liveTool: 'read_policy', edit: { 'shop.mjs': replace('Refunds up to $100: issue the refund. Refunds above $100 need', 'Refunds up to $500: issue the refund. Refunds above $500 need') } },

  // No-ops: none should break a good run.
  { id: 'reworded-prompt', suite: 'keeps', kind: 'no-op', what: 'The prompt says the same in other words', edit: { 'prompt.txt': () => 'You work in support for an online shop. When a customer asks for a refund: first look the order up, next read the refund policy, and then do what it says. Follow the policy exactly. Once finished, tell the customer what you did in one sentence.\n' } },
  { id: 'support-hours', suite: 'keeps', kind: 'no-op', what: 'The prompt gains a line about support hours', edit: { 'prompt.txt': replace('Follow the policy exactly.', 'Follow the policy exactly. The shop’s support hours are 9 to 17 on weekdays.') } },
  { id: 'tools-reordered', suite: 'keeps', kind: 'no-op', what: 'The tool list in another order', edit: { 'tools.json': tools((list) => [...list].reverse()) } },
  { id: 'reworded-description', suite: 'keeps', kind: 'no-op', what: 'lookup_order described in other words', edit: { 'tools.json': describe('lookup_order', 'Look up an order by its id.') } },
  { id: 'refactor', suite: 'keeps', kind: 'no-op', what: 'A rename in the agent’s code that changes no request', edit: { 'agent.mjs': (text) => text.replaceAll('impls', 'handlers') } },

  // Fixes and changes that fix nothing, on the subject that never reads the policy.
  { id: 'fix-read-policy', suite: 'fixes', kind: 'fix', what: 'The prompt says to read the policy and follow it', edit: { 'prompt.txt': () => 'You are a support agent for an online shop. For a refund request, look the order up, then read the refund policy, then act on it. Follow the policy exactly. When you are done, tell the customer in one sentence what you did.\n' } },
  { id: 'fix-rule-in-prompt', suite: 'fixes', kind: 'fix', what: 'The prompt states the rule itself', edit: { 'prompt.txt': replace('then issue the refund.', 'then issue the refund if it is $100 or less. A refund above $100 needs a manager: escalate it and do not issue the refund.') } },
  { id: 'fix-nothing-reworded', suite: 'fixes', kind: 'no-fix', what: 'The broken prompt in other words', edit: { 'prompt.txt': () => 'You work in support for an online shop. When a customer asks for a refund, look the order up and then issue the refund. Once finished, tell the customer what you did in one sentence.\n' } },
  { id: 'fix-nothing-polite', suite: 'fixes', kind: 'no-fix', what: 'The prompt gains a line about tone', edit: { 'prompt.txt': replace('then issue the refund.', 'then issue the refund. Be polite and concise.') } },
  { id: 'fix-only-its-example', suite: 'fixes', kind: 'no-fix', what: 'A rule that fits only the run it was written for: escalate above $200 (the held-out order is $180)', edit: { 'prompt.txt': replace('then issue the refund.', 'then issue the refund. A refund above $200 needs a manager: escalate it and do not issue the refund.') } },
];
