# support-agent

Northwind's support agents, recorded with Shadowlap. Every model in this project is a scripted
stand-in served on this machine: nothing here talks to a real provider.

| Command | What it does |
|---|---|
| `node refund_agent.mjs T-8812` | Works one ticket end to end: the order, the customer, fraud risk, the policy and the regional limit, then refunds or escalates and emails the customer (Anthropic, streamed, with thinking) |
| `node refund_agent.mjs --batch inbox/2026-09-30.jsonl` | The overnight batch: every ticket in the file, one conversation each |
| `node agent.mjs A-1042` | The first refund agent: looks the order up, reads the policy, refunds or escalates |
| `node eval_conversation.mjs --persona damaged-order` | An eval: a model plays the customer, and the agent hands the policy check to a sub-agent |
| `node support_chat.mjs` | The support chat, which waits for what the customer types |
| `node triage.mjs` | Labels the unread support threads (OpenAI) |
| `node digest.mjs` | Posts the weekly refund digest (Gemini) |
| `node faq.mjs "<question>"` | Answers from the help center, an MCP server (`kb_server.mjs`) that `.mcp.json` starts behind `shadowlap mcp` |
