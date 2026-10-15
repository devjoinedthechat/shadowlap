import { describe, expect, it } from 'vitest';
import { HttpError, Router } from '../src/index.js';

const noop = () => undefined;

function status(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
}

describe('the route table', () => {
  it('matches a method and a pattern, with URL-decoded parameters', () => {
    const router = new Router();
    const run = (): void => undefined;
    const call = (): void => undefined;
    router.get('/runs/:id', run).get('/runs/:id/calls/:n', call);
    const m = router.match('GET', '/runs/01K5%2FQ/calls/17');
    expect(m.handler).toBe(call);
    expect(m.params).toEqual({ id: '01K5/Q', n: '17' });
    expect(m.pattern).toBe('/runs/:id/calls/:n');
    expect(router.match('GET', '/runs/abc/').params).toEqual({ id: 'abc' }); // a trailing slash is the same path
  });

  it('prefers literal segments to parameters, earliest first', () => {
    const router = new Router();
    const byId = (): void => undefined;
    const kinds = (): void => undefined;
    const early = (): void => undefined;
    router.get('/jobs/:id', byId).get('/jobs/kinds', kinds).get('/:a/:b/x', noop).get('/jobs/:b/:c', early);
    expect(router.match('GET', '/jobs/kinds').handler).toBe(kinds);
    expect(router.match('GET', '/jobs/0123abcd').handler).toBe(byId);
    expect(router.match('GET', '/jobs/q/x').handler).toBe(early);
  });

  it('answers 404 for no route, 405 for another method, 400 for bad encoding, and HEAD from GET', () => {
    const router = new Router();
    const get = (): void => undefined;
    router.get('/runs/:id', get).delete('/runs/:id', noop);
    expect(status(() => router.match('GET', '/nope'))).toBe(404);
    expect(status(() => router.match('GET', '/runs//x'))).toBe(404);
    expect(status(() => router.match('PUT', '/runs/abc'))).toBe(405);
    expect(status(() => router.match('GET', '/runs/%E0%A4%A'))).toBe(400);
    expect(router.match('HEAD', '/runs/abc').handler).toBe(get);
  });

  it('marks every route but a GET as a write unless it says it changes nothing', () => {
    const router = new Router();
    router.get('/a', noop).post('/a', noop).post('/preview', noop, { write: false }).delete('/a', noop).put('/b', noop).patch('/b', noop);
    expect(router.list().map((r) => [r.method, r.pattern, r.write])).toEqual([
      ['GET', '/a', false],
      ['POST', '/a', true],
      ['POST', '/preview', false],
      ['DELETE', '/a', true],
      ['PUT', '/b', true],
      ['PATCH', '/b', true],
    ]);
    expect(router.match('POST', '/preview').write).toBe(false);
  });

  it('refuses a route registered twice, a parameter used twice, and a bad parameter', () => {
    const router = new Router().get('/runs/:id', noop);
    expect(() => router.get('/runs/:runId', noop)).toThrow(/registered twice/);
    expect(() => router.post('/runs/:id', noop)).not.toThrow();
    expect(() => router.get('/x/:id/y/:id', noop)).toThrow(/used twice/);
    expect(() => router.get('/x/:', noop)).toThrow(/a parameter is/);
    expect(() => router.get('/x//y', noop)).toThrow(/empty segment/);
  });
});
