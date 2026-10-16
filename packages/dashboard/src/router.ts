import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, jsonTagged, readObject } from './http.js';

/**
 * The API's route table: a method and a path pattern under `/api/`, such as `/runs/:id/calls/:n`,
 * mapped to a handler. The server does what every request needs before a handler runs (the Host
 * check, the session token, same-origin writes, read-only), so a handler only answers.
 *
 * Each feature registers its routes from its own module, `routes/<feature>.ts`, which exports
 * `register(router, ctx)`; `routes/index.ts` lists the modules. Adding a feature is that file and
 * one line in the list:
 *
 *   // routes/fixes.ts
 *   import { HttpError } from '../http.js';
 *   import type { Router } from '../router.js';
 *   import type { RouteContext } from '../context.js';
 *
 *   export function register(router: Router, ctx: RouteContext): void {
 *     router.get('/fixes', (r) => r.tagged({ fixes: listFixes(ctx.store) }));
 *     router.get('/fixes/:id', (r) => {
 *       const fix = getFix(ctx.store, r.params.id);   // a read model: store in, JSON out
 *       if (!fix) throw new HttpError(404, `no fix ${r.params.id}`);
 *       r.tagged(fix);
 *     });
 *     router.post('/fixes/:id/title', async (r) => {  // a write: refused on a read-only dashboard
 *       const body = await r.body();
 *       r.json(setTitle(ctx.store, r.params.id, body.title));
 *     });
 *     ctx.jobs.registerJobKind('blame', { title: () => 'Blaming', build: (req) => … });
 *   }
 *
 * Every route but a GET is a write, refused with 403 on a read-only dashboard; a POST that changes
 * nothing (a preview, a dry run) says so with `{ write: false }`. Throw an `HttpError` to answer
 * with its status and `{ error }`; anything else thrown is a 500, logged.
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Path parameters by name, URL-decoded: `/runs/:id` gives `params.id`. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Answers with JSON, `no-store` (200 unless given). */
  json(body: unknown, status?: number): void;
  /** Answers with JSON and an ETag: a 304 when the browser already has it. For read models. */
  tagged(body: unknown): void;
  /** The body as a JSON object (at most 256 KB): what write endpoints take. */
  body(): Promise<Record<string, unknown>>;
}

export type Handler = (r: RouteRequest) => void | Promise<void>;

export interface RouteOptions {
  /**
   * Whether the route changes something, so a read-only dashboard refuses it. Defaults to true for
   * every method but GET. A POST that changes nothing (a preview, a dry run) passes false.
   */
  write?: boolean;
  /**
   * On a dashboard that serves several projects, a request that isn't a GET is refused when the
   * page that sends it shows another project than the current one (it would act on the wrong one).
   * A route that names what it acts on itself, a project or a job by its id, passes true.
   */
  anyProject?: boolean;
}

interface Route {
  method: Method;
  pattern: string;
  parts: string[];
  handler: Handler;
  write: boolean;
  anyProject: boolean;
}

export interface Match {
  handler: Handler;
  params: Record<string, string>;
  write: boolean;
  pattern: string;
  /** The route names what it acts on: a page showing another project may call it (`RouteOptions.anyProject`). */
  anyProject: boolean;
}

const PARAM = /^:([A-Za-z_]\w*)$/;

function split(path: string): string[] {
  return path.replace(/^\/+|\/+$/g, '').split('/');
}

export class Router {
  private readonly routes: Route[] = [];

  /** Adds a route. Patterns are literal segments and `:name` parameters, each one whole segment. */
  add(method: Method, pattern: string, handler: Handler, options: RouteOptions = {}): this {
    const parts = split(pattern);
    for (const p of parts) {
      if (p.startsWith(':') && !PARAM.test(p)) throw new Error(`route ${pattern}: a parameter is ":" and a name`);
      if (!p) throw new Error(`route ${pattern}: an empty segment`);
    }
    const names = parts.filter((p) => p.startsWith(':'));
    if (new Set(names).size !== names.length) throw new Error(`route ${pattern}: a parameter name is used twice`);
    const shape = parts.map((p) => (p.startsWith(':') ? ':' : p)).join('/');
    if (this.routes.some((r) => r.method === method && r.parts.map((p) => (p.startsWith(':') ? ':' : p)).join('/') === shape)) throw new Error(`route ${method} ${pattern} is registered twice`);
    this.routes.push({ method, pattern, parts, handler, write: options.write ?? method !== 'GET', anyProject: options.anyProject ?? false });
    return this;
  }

  get(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add('GET', pattern, handler, options);
  }

  post(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add('POST', pattern, handler, options);
  }

  put(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add('PUT', pattern, handler, options);
  }

  patch(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add('PATCH', pattern, handler, options);
  }

  delete(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add('DELETE', pattern, handler, options);
  }

  /**
   * The route for a request path under `/api/`. Literal segments win over parameters, earliest
   * first, so `/jobs/kinds` is not taken for `/jobs/:id`. A path that exists under another method is
   * a 405; nothing at all, a 404. HEAD is answered by the GET route.
   */
  match(method: string, pathname: string): Match {
    const segments = split(pathname);
    const m = method === 'HEAD' ? 'GET' : method;
    let best: { route: Route; params: Record<string, string>; rank: string } | null = null;
    let otherMethod = false;
    for (const route of this.routes) {
      if (route.parts.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let rank = '';
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const part = route.parts[i]!;
        const seg = segments[i]!;
        if (part.startsWith(':')) {
          if (!seg) {
            ok = false;
            break;
          }
          let value: string;
          try {
            value = decodeURIComponent(seg);
          } catch {
            throw new HttpError(400, `the path segment "${seg.slice(0, 80)}" is not valid URL encoding`);
          }
          params[part.slice(1)] = value;
          rank += '0';
        } else if (part === seg) rank += '1';
        else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== m) {
        otherMethod = true;
        continue;
      }
      // A literal earlier in the path beats a parameter there: compare literal-or-not left to right.
      if (!best || rank > best.rank) best = { route, params, rank };
    }
    if (best) return { handler: best.route.handler, params: best.params, write: best.route.write, pattern: best.route.pattern, anyProject: best.route.anyProject };
    const path = `/api/${segments.join('/')}`;
    if (otherMethod) throw new HttpError(405, `${method} is not allowed on ${path}`);
    throw new HttpError(404, `no endpoint ${method} ${path}`);
  }

  /** Every route, for the docs and the tests. */
  list(): Array<{ method: Method; pattern: string; write: boolean }> {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern, write: r.write }));
  }
}

/** The request a handler gets: the matched parameters and the answer helpers. */
export function routeRequest(req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>): RouteRequest {
  return {
    req,
    res,
    url,
    params,
    query: url.searchParams,
    json: (body, status = 200) => json(res, status, body),
    tagged: (body) => jsonTagged(req, res, body),
    body: () => readObject(req),
  };
}
