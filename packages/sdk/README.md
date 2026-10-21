# @shadowlap/sdk

Wrap your agent's tools once with their effect, so [Shadowlap](https://github.com/devjoinedthechat/shadowlap) records every call and a replay serves it from the recording instead of running it again.

```sh
npm install @shadowlap/sdk
```

```ts
import { tool } from '@shadowlap/sdk';

export const lookupOrder = tool('lookup_order', { effect: 'read' },
  async ({ order_id }: { order_id: string }) => orders.get(order_id));

export const issueRefund = tool('issue_refund', { effect: 'write' },
  async ({ order_id, amount }: { order_id: string; amount: number }) =>
    payments.refund(order_id, amount));
```

Record and replay with the [`shadowlap` CLI](https://www.npmjs.com/package/shadowlap): `shadowlap run -- node agent.mjs`, then `shadowlap replay <run>`. Outside Shadowlap every wrapper is a passthrough, so the code ships unchanged.

- `effect` is required: `pure` (depends only on its arguments), `read` (reads outside state) or `write` (changes it). After a fork, `read` tools run live and a `write` throws `ShadowlapWriteBlocked`, unless the replay stubs or allows writes.
- `now()`, `random()` and `uuid()`, all asynchronous, record the clock and randomness, so a replay sees the values the run saw.
- `scope()` names branches of the agent that run at once, `userInput()` records what a person types, and `trust: 'untrusted'` marks a read for injection tests.
- A tool that a replay's `--fail-at` fails throws `ShadowlapInjectedFailure` without running, named `TimeoutError` for a timeout and with `status` for an HTTP status. `isActive()` says whether the agent runs under Shadowlap.

Node 18 or later, no dependencies. Model calls need no SDK: `shadowlap run` points the provider SDKs at its sidecar through their base URLs.

[SDKs](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/sdk.md) · [Frameworks](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/frameworks.md) · [How it works](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/how-it-works.md)
