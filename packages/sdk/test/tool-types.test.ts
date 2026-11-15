import { describe, expect, expectTypeOf, it } from 'vitest';
import { tool } from '@shadowlap/sdk';

// What tool() returns, as TypeScript sees it and as it runs. The type assertions are checked by
// `npm run typecheck:tests`; the calls run outside shadowlap, where a call goes straight to the
// implementation and still comes back as a promise.
describe("tool()'s types", () => {
  it('give a tool whose implementation only throws a promise, which is what a call returns', async () => {
    // An implementation that always throws returns `never`, which matched the async generator
    // overload first, so its calls were typed as streams.
    const boom = tool('boom', { effect: 'read' }, () => {
      throw new Error('boom');
    });
    expectTypeOf(boom).returns.toEqualTypeOf<Promise<never>>();
    await expect(boom({})).rejects.toThrow('boom');

    // A write that only throws, with a stub for a fork: a forked call returns the stub.
    const refuse = tool('refuse', { effect: 'write', onFork: () => ({ refused: true }) }, (): never => {
      throw new Error('refused');
    });
    expectTypeOf(refuse).returns.toEqualTypeOf<Promise<{ refused: boolean }>>();
    await expect(refuse({})).rejects.toThrow('refused');
  });

  it('still give an async generator a stream and any other implementation a promise of its result', async () => {
    const pages = tool('pages', { effect: 'read' }, async function* ({ n }: { n: number }) {
      for (let i = 0; i < n; i++) yield i;
    });
    expectTypeOf(pages).returns.toEqualTypeOf<AsyncGenerator<number, void, undefined>>();
    const seen: number[] = [];
    for await (const page of pages({ n: 3 })) seen.push(page);
    expect(seen).toEqual([0, 1, 2]);

    const add = tool('add', { effect: 'pure' }, ({ a, b }: { a: number; b: number }) => a + b);
    expectTypeOf(add).returns.toEqualTypeOf<Promise<number>>();
    expect(await add({ a: 1, b: 2 })).toBe(3);

    const later = tool('later', { effect: 'read' }, async () => 'done');
    expectTypeOf(later).returns.toEqualTypeOf<Promise<string>>();
    expect(await later({})).toBe('done');
  });
});
