# @shadowlap/sdk

The Shadowlap SDK for TypeScript: `tool(name, { effect }, impl)` wraps a tool so Shadowlap records it and fences writes after a fork; `now()`, `random()` and `uuid()` record clock and randomness. Without `SHADOWLAP_URL` set, everything is a passthrough.

```ts
import { tool, now } from '@shadowlap/sdk';
export const sendEmail = tool('send_email', { effect: 'write' }, async (args) => mailer.send(args));
```

Docs: https://github.com/devjoinedthechat/shadowlap
