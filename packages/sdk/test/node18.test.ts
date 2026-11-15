import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { now, random, uuid } from '../src/index.js';

/**
 * The package says it runs on Node 18.18. Node 18 has no `globalThis.crypto` unless it is started with
 * --experimental-global-webcrypto, so nothing outside shadowlap may reach for it: here it is taken
 * away as Node 18 leaves it, and the helpers still answer.
 */
describe('outside shadowlap on a Node with no global crypto (Node 18)', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let url: string | undefined;

  beforeEach(() => {
    url = process.env.SHADOWLAP_URL;
    delete process.env.SHADOWLAP_URL;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  });
  afterEach(() => {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    if (url !== undefined) process.env.SHADOWLAP_URL = url;
  });

  it('uuid() returns a version 4 UUID', async () => {
    expect((globalThis as { crypto?: unknown }).crypto).toBeUndefined();
    const id = await uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await uuid()).not.toBe(id);
  });

  it('now() and random() answer too', async () => {
    expect(Math.abs((await now()) - Date.now())).toBeLessThan(5_000);
    const r = await random();
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });
});
