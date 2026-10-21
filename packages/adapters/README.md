# @shadowlap/adapters

Declare each tool's effect once, in the framework you already use, so [Shadowlap](https://github.com/devjoinedthechat/shadowlap) records its calls and a replay serves them from the recording.

```sh
npm install @shadowlap/sdk @shadowlap/adapters
```

```js
import { generateText } from 'ai';
import { withEffects } from '@shadowlap/adapters/ai-sdk';

const tools = withEffects(
  { lookup_order, issue_refund },                    // your AI SDK tools, as tool() made them
  { lookup_order: 'read', issue_refund: 'write' },
);

await generateText({ model, tools, prompt: 'Order A-1042: the customer asks for a refund.' });
```

| Framework | Adapter |
|---|---|
| Vercel AI SDK | `withEffects` from `@shadowlap/adapters/ai-sdk` |
| OpenAI Agents SDK | `withEffect` from `@shadowlap/adapters/openai-agents` |
| Mastra | `withEffect` from `@shadowlap/adapters/mastra`, or `withEffectV0` for Mastra 0.x |
| LangChain and LangGraph | `withEffect` from `@shadowlap/adapters/langchain` |
| Anthropic tool runner | `withEffect` from `@shadowlap/adapters/anthropic` |

Only the framework's input is recorded, never its context objects. The adapters carry no framework dependencies, and each one but `withEffectV0` (Mastra 0.x) is tested in CI against the framework itself. Node 18.18 or later, like the SDK.

[Frameworks](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/frameworks.md) shows each adapter in use, with the versions it is tested against.
