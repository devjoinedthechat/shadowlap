# @shadowlap/sidecar

The proxy `shadowlap run` starts beside an agent: it records and replays the agent's model calls byte for byte, and answers the tool, clock and random calls of [Shadowlap](https://github.com/devjoinedthechat/shadowlap)'s SDKs.

```sh
npm install @shadowlap/sidecar @shadowlap/engine
```

```ts
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';

const store = Store.open('.shadowlap/shadowlap.db');
const sidecar = await Sidecar.start({ store });
const run = sidecar.startRun({ mode: 'record', command: { argv: ['node', 'agent.mjs', 'A-1042'], cwd: process.cwd() } });

const agent = spawn('node', ['agent.mjs', 'A-1042'], {
  env: { ...process.env, ...sidecar.envFor(run.runId) },   // the provider base URLs and SHADOWLAP_URL
  stdio: 'inherit',
});
await once(agent, 'exit');
console.log(sidecar.endRun(run.runId, 'completed').summary.byKind);   // { api: 5, tool: 4, clock: 0, random: 0 }

await sidecar.close();
store.close();
```

It listens on 127.0.0.1, with the session token in every path. Anthropic, OpenAI and compatible servers, and Gemini reach it through the base URLs `envFor()` sets; Azure OpenAI, Gemini Enterprise Agent Platform (Vertex AI) and Amazon Bedrock calls arrive through the CLI's in-process capture, and so do calls to HTTP services the config declares, which it records as tool calls. Keys are forwarded to the provider and never stored. Most people never start one by hand: the [`shadowlap` CLI](https://www.npmjs.com/package/shadowlap) does it for every run.

[How it works](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/how-it-works.md) · [Providers](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/providers.md) · [The wire protocol](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/protocol.md)
