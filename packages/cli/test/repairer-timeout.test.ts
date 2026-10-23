import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { askRepairer, describeLimit, RepairerError } from '../src/repairer.js';

/**
 * The repairer is asked once per repair, and a repairer that never answers (a gateway that holds the
 * connection, a local model server stuck loading) would hold the repair, and the CI job running it,
 * until something else killed it. It is given a time limit, and stopped by Ctrl-C, whatever it is.
 * The servers here accept the request and never answer.
 */
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function silent(): Promise<string> {
  const server = createServer(() => {
    // never answers
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const prompt = { system: 'You improve AI agents.', user: 'Rewrite the span.' };

describe('the repairer time limit', () => {
  it('gives up on an OpenAI-compatible server that never answers, and says how long it waited', async () => {
    const url = await silent();
    const started = Date.now();
    const asked = askRepairer({ provider: 'openai', model: 'local-model', baseUrl: `${url}/v1` }, prompt, undefined, { timeoutMs: 1000 });
    await expect(asked).rejects.toBeInstanceOf(RepairerError);
    await expect(asked).rejects.toMatchObject({ what: 'it did not answer within 1 second', message: 'it did not answer within 1 second: give it longer with --repairer-timeout <seconds>, or repair.timeout in shadowlap.config.json' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('gives up on the Anthropic API when it never answers, retries included', async () => {
    const url = await silent();
    const key = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const started = Date.now();
      await expect(askRepairer({ provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: url }, prompt, undefined, { timeoutMs: 1500 })).rejects.toMatchObject({ what: 'it did not answer within 2 seconds' });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = key;
    }
  });

  it('stops when its signal aborts, as Ctrl-C does', async () => {
    const url = await silent();
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    await expect(askRepairer({ provider: 'openai', model: 'local-model', baseUrl: `${url}/v1` }, prompt, undefined, { timeoutMs: 60_000, signal: stop.signal })).rejects.toMatchObject({ what: 'it was stopped before it answered' });
  });

  it('says a limit as a person reads it', () => {
    expect([600_000, 120_000, 90_000, 2_000, 1_000].map(describeLimit)).toEqual(['10 minutes', '2 minutes', '90 seconds', '2 seconds', '1 second']);
  });
});
