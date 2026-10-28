// Shadowlap's recorded user input for Node agents. Preloaded with capture and the network guard
// (NODE_OPTIONS=--import), so an interactive agent needs no code change.
//
// What a person types is input from outside, like a tool's result: each line an agent reads from
// its terminal through readline (rl.question, readline/promises, `for await (const line of rl)`) is
// recorded as a `user_input` tool call with effect read, `input: true`, and the prompt as its
// argument; the answer is its result, `{ text }`. A replay serves the answers from the recording,
// so `shadowlap test`, `blame` and `verify`, which start agents with no one at the keyboard, run
// interactive agents too. Reading through 'line' events is not recorded.
//
// Only the input Shadowlap gave the agent counts: a terminal, the null device (stdin ignored), or
// the very pipe or file `shadowlap` itself was given (SHADOWLAP_STDIN names it). A child process that
// talks to its parent over a pipe, an MCP server for one, is left alone.
import { fstatSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { isatty } from 'node:tty';

const sidecarUrl = process.env.SHADOWLAP_URL;
const runId = process.env.SHADOWLAP_RUN_ID;

/**
 * globalThis as the preloads share it: whether each set itself up, and what they hand each other
 * under registered symbols (the request functions capture found, the SDK's scope).
 * @type {typeof globalThis & { __shadowlapInput?: boolean } & Record<symbol, unknown>}
 */
const shared = globalThis;

/** @typedef {{ getStore?: () => unknown } | undefined} Store What the SDK keeps for the call in progress (an AsyncLocalStorage), under a registered symbol. */
/** @typedef {{ text: string; eof?: false } | { eof: true; text?: undefined }} Read What a person's input gave: a line, or its end. */
/** @typedef {Read & { served: boolean }} Answer A line, or the input's end, and whether the recording served it. */
/**
 * A readline interface as Node makes one: its input and output, and whether it closed, which Node's
 * types leave out.
 * @typedef {import('node:readline').Interface & { input: NodeJS.ReadableStream & { writableEnded?: boolean; end?: () => void }; output?: NodeJS.WritableStream & { isTTY?: boolean }; closed?: boolean }} Rl
 */

/** Whether fd 0 is the input Shadowlap gave the agent, and whether nobody can type on it. */
function stdinOrigin() {
  try {
    if (isatty(0)) return 'person';
    // Exact and unsigned, as the CLI writes SHADOWLAP_STDIN: a pipe's inode can be beyond a double's
    // precision, and Node's big integers for it are signed.
    const unsigned = (/** @type {bigint} */ n) => (n < 0n ? n + (1n << 64n) : n);
    const own = fstatSync(0, { bigint: true });
    // A character device that is not a terminal is the null device (stdin ignored), on Windows too.
    if (own.isCharacterDevice()) return 'nobody';
    // On Windows only a file is named by SHADOWLAP_STDIN: Node numbers a pipe by its handle, this
    // process's own number for it, which the pipe `shadowlap` was given may have had too.
    if (process.platform === 'win32' && !own.isFile()) return null;
    if (own.ino && process.env.SHADOWLAP_STDIN === `${unsigned(own.dev)}:${unsigned(own.ino)}`) return 'person';
  } catch {
    // no fd 0 at all
  }
  return null;
}

const origin = sidecarUrl && !shared.__shadowlapInput ? stdinOrigin() : null;

if (sidecarUrl && origin) {
  shared.__shadowlapInput = true;
  const base = sidecarUrl.replace(/\/$/, '');
  // The sidecar is reached directly, never through a proxy: not with fetch, whose dispatcher the
  // agent may route through one that ignores NO_PROXY, nor with an http.globalAgent a proxy package
  // replaced. The request functions are taken now, before the agent's own code runs.
  const original = /** @type {{ 'http:'?: typeof http.request; 'https:'?: typeof https.request }} */ (shared[Symbol.for('shadowlap.request')] ?? {});
  /** @type {Record<string, [typeof http.request, http.Agent]>} */
  const sidecarClients = { 'http:': [original['http:'] ?? http.request, new http.Agent({ keepAlive: true })], 'https:': [original['https:'] ?? https.request, new https.Agent({ keepAlive: true })] };
  /**
   * One POST to the sidecar, and its status and text.
   * @param {string} url
   * @param {Record<string, string>} headers
   * @param {string} body
   * @param {boolean} [retried]
   * @returns {Promise<{ status: number; text: string }>}
   */
  function send(url, headers, body, retried = false) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const [request, agent] = sidecarClients[target.protocol] ?? /** @type {[typeof http.request, http.Agent]} */ (sidecarClients['http:']);
      const req = request(target, { method: 'POST', headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) }, agent }, (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (/** @type {Buffer} */ c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
        // A kept-alive socket the sidecar closed while it was idle: once more, on a new one.
        if (req.reusedSocket && !retried && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) send(url, headers, body, true).then(resolve, reject);
        else reject(err);
      });
      req.end(body);
    });
  }
  const baseScope = (() => {
    const raw = process.env.SHADOWLAP_SCOPE?.trim();
    return raw && raw.length <= 200 && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : undefined;
  })();

  /**
   * A call to the sidecar's API, and its JSON answer; an answer other than 2xx throws.
   * @param {string} path
   * @param {unknown} body
   * @returns {Promise<any>}
   */
  async function post(path, body) {
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json', 'user-agent': 'shadowlap-input-node' };
    if (runId) headers['x-shadowlap-run'] = runId;
    const scope = /** @type {string | undefined} */ (/** @type {Store} */ (shared[Symbol.for('shadowlap.scope')])?.getStore?.() ?? baseScope);
    // % and anything outside printable ASCII percent-encoded, as the SDK sends it: a header holds Latin-1 at most.
    if (scope) headers['x-shadowlap-scope'] = scope.replace(/[^\x20-\x24\x26-\x7e]/gu, (c) => {
      try {
        return encodeURIComponent(c);
      } catch {
        return '%EF%BF%BD';
      }
    });
    const res = await send(`${base}${path}`, headers, JSON.stringify(body));
    const text = res.text;
    if (res.status < 200 || res.status >= 300) {
      let message = text;
      try {
        message = JSON.parse(text).error?.message ?? text;
      } catch {
        // keep the raw text
      }
      throw new Error(`shadowlap sidecar ${path} failed (${res.status}): ${message}`);
    }
    return JSON.parse(text);
  }

  /**
   * The text of a recorded answer: `{ text }`, or a bare string from an override.
   * @param {unknown} result
   * @returns {string}
   */
  const textOf = (result) => {
    const text = result && typeof result === 'object' ? /** @type {{ text?: unknown }} */ (result).text : undefined;
    return typeof result === 'string' ? result : typeof text === 'string' ? text : result == null ? '' : JSON.stringify(result);
  };

  /**
   * One person's answer: from the recording when the replay has it, else read live and recorded.
   * `readLive` resolves `{ text }`, or `{ eof: true }` when the input ended. Resolves
   * `{ text, served }` or `{ eof: true, served }`.
   * @param {string} prompt
   * @param {() => Promise<Read>} readLive
   * @returns {Promise<Answer>}
   */
  async function userInput(prompt, readLive) {
    const r = await post('/v1/calls/resolve', { kind: 'tool', name: 'user_input', effect: 'read', args: { prompt }, input: true });
    if (r.origin === 'replayed') return r.outcome === 'ok' ? { text: textOf(r.result), served: true } : { eof: true, served: true };
    if (r.origin !== 'live') throw new Error(`shadowlap: unexpected origin ${r.origin} for user input`);
    const started = Date.now();
    /** @type {Read} */
    let got;
    try {
      got = await readLive();
    } catch (err) {
      const failed = /** @type {{ name?: unknown; message?: unknown } | null | undefined} */ (err);
      await post(`/v1/calls/${r.callNo}/complete`, { outcome: 'error', error: { name: failed?.name ?? 'Error', message: String(failed?.message ?? err) }, latencyMs: Date.now() - started });
      throw err;
    }
    const latencyMs = Date.now() - started;
    if (got.eof) await post(`/v1/calls/${r.callNo}/complete`, { outcome: 'error', error: { name: 'EOFError', message: 'end of input' }, latencyMs });
    else await post(`/v1/calls/${r.callNo}/complete`, { outcome: 'ok', result: { text: got.text }, latencyMs });
    return { ...got, served: false };
  }

  // With no one at the keyboard (stdin ignored), the interface gets a stream that ends when the
  // conversation does: when the agent asks for an answer the recording doesn't have, or the
  // recording says the input ended. Ending at once, as /dev/null would, closes the interface before
  // the first question and runs the agent's 'close' handler out of turn.
  /** @type {WeakSet<object>} */
  const deferred = new WeakSet();
  const endInput = (/** @type {Rl} */ rl) => {
    if (deferred.has(rl.input) && !rl.input.writableEnded) rl.input.end?.();
  };
  // userInput() from the SDK records its own answer, so a readline read inside it is not recorded
  // again; with no one at the keyboard it gets the input's end, as it would have.
  const direct = () => /** @type {Store} */ (shared[Symbol.for('shadowlap.input.direct')])?.getStore?.() === true;
  const isUsers = (/** @type {Rl} */ rl) => {
    if (rl.input !== process.stdin && !deferred.has(rl.input)) return false;
    if (!direct()) return true;
    endInput(rl);
    return false;
  };

  /**
   * A served answer as the terminal would have shown it: the prompt (unless the real question showed it), and the line as if typed.
   * @param {Rl} rl
   * @param {string} prompt
   * @param {string | null} text
   * @param {boolean} asked
   */
  function show(rl, prompt, text, asked) {
    const out = rl.output;
    if (!out || typeof out.write !== 'function') return;
    if (prompt && !asked) out.write(prompt);
    if (out.isTTY && text !== null) out.write(`${text}\n`);
  }

  /**
   * The next line someone types, or `{ eof: true }` when the interface closes first.
   * @param {Rl} rl
   * @param {(ok: (text: string) => void, fail: (err: unknown) => void) => void} ask
   * @returns {Promise<Read>}
   */
  function liveLine(rl, ask) {
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {<T = void>(fn: (value: T) => void) => (value: T) => void} */
      const settle = (fn) => (value) => {
        if (settled) return;
        settled = true;
        rl.off('close', onClose);
        fn(value);
      };
      const onClose = settle(() => resolve({ eof: true }));
      if (rl.closed) return onClose();
      rl.once('close', onClose);
      ask(settle((/** @type {string} */ text) => resolve({ text })), settle(reject));
    });
  }

  /**
   * One question a person answers. Node hands the next line to a question from the moment it is
   * asked, so when someone may type, the real question is asked at once, as Node would, and withdrawn
   * if the recording answers it. `askReal(signal, ok, fail)` asks it. Resolves
   * `{ text, served, asked }` or `{ eof: true, served, asked }`.
   * @param {Rl} rl
   * @param {string} prompt
   * @param {AbortSignal | undefined} userSignal
   * @param {(signal: AbortSignal, ok: (text: string) => void, fail: (err: unknown) => void) => void} askReal
   * @returns {Promise<Answer & { asked: boolean }>}
   */
  function answer(rl, prompt, userSignal, askReal) {
    /** @type {Promise<Read> | null} */
    let live = null;
    const controller = new AbortController();
    if (origin === 'person' && !rl.closed) {
      if (userSignal) userSignal.addEventListener('abort', () => controller.abort(userSignal.reason), { once: true });
      live = liveLine(rl, (ok, fail) => askReal(controller.signal, ok, fail));
      // A withdrawn question rejects; nothing waits on it then.
      live.catch(() => {});
    }
    /** @returns {Promise<Read>} */
    const readLive = () => {
      if (live) return live;
      // No one can type here (or the input already ended): the answer is the input's end.
      endInput(rl);
      return Promise.resolve({ eof: true });
    };
    return userInput(prompt, readLive).then(
      (got) => {
        if (got.served) controller.abort();
        return { ...got, asked: live !== null };
      },
      (err) => {
        controller.abort();
        throw err;
      },
    );
  }

  /**
   * The input ended: as with Node's own question, the answer never comes and the interface closes.
   * @param {Rl} rl
   * @param {Answer} got
   */
  function ended(rl, got) {
    endInput(rl);
    if (got.served) rl.close();
  }

  /**
   * The input an interface reads: with no one at the keyboard, a stream of its own in place of stdin, which ends when the conversation does.
   * @template T
   * @param {T} input
   * @returns {T | PassThrough}
   */
  function substitute(input) {
    if (origin !== 'nobody' || input !== process.stdin) return input;
    const proxy = new PassThrough();
    deferred.add(proxy);
    return proxy;
  }

  /**
   * An interface over a stream of its own, watched for 'line' listeners, which get the input's end.
   * @param {Rl} rl
   * @returns {Rl}
   */
  function watchForLineReaders(rl) {
    if (!deferred.has(rl.input)) return rl;
    // 'line' events are not recorded: an agent reading them gets the input's end at once, as it would have.
    const check = (/** @type {string | symbol} */ event) => event === 'line' && endInput(rl);
    rl.on('newListener', check);
    setImmediate(() => rl.listenerCount('line') && endInput(rl));
    return rl;
  }

  for (const mod of /** @type {Array<{ createInterface: (...args: unknown[]) => unknown }>} */ ([readline, readlinePromises])) {
    const create = mod.createInterface;
    mod.createInterface = /**
     * @this {unknown}
     * @param {unknown} input
     * @param {unknown[]} rest
     */ function createInterface(input, ...rest) {
      if (input && typeof input === 'object' && 'input' in input && !(typeof (/** @type {{ on?: unknown }} */ (input).on) === 'function')) return watchForLineReaders(/** @type {Rl} */ (Reflect.apply(create, this, [{ ...input, input: substitute(input.input) }, ...rest])));
      return watchForLineReaders(/** @type {Rl} */ (Reflect.apply(create, this, [substitute(input), ...rest])));
    };
  }

  // rl.question(query[, options], callback)
  const question = readline.Interface.prototype.question;
  /**
   * @this {Rl}
   * @param {string} query
   * @param {{ signal?: AbortSignal } | ((answer: string) => void) | undefined} options
   * @param {((answer: string) => void) | undefined} [cb]
   */
  const recordedQuestion = function (query, options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = undefined;
    }
    if (!isUsers(this) || typeof cb !== 'function' || options?.signal?.aborted) return Reflect.apply(question, this, [query, options ?? {}, cb]);
    const rl = this;
    const prompt = String(query);
    const answered = cb;
    answer(rl, prompt, options?.signal, (signal, ok) => question.call(rl, query, { ...options, signal }, ok))
      .then((got) => {
        if (got.eof) return ended(rl, got);
        if (got.served) show(rl, prompt, got.text, got.asked);
        answered(got.text);
      })
      .catch((err) => process.nextTick(() => rl.emit('error', err)));
  };
  // util.promisify(rl.question) resolves with the answer, as Node's own question does.
  Object.assign(recordedQuestion, {
    /**
     * @this {Rl}
     * @param {string} query
     * @param {{ signal?: AbortSignal } | undefined} options
     */
    [Symbol.for('nodejs.util.promisify.custom')](query, options) {
      return new Promise((resolve) => recordedQuestion.call(this, query, options ?? {}, resolve));
    },
  });
  readline.Interface.prototype.question = /** @type {typeof question} */ (recordedQuestion);

  // await rl.question(query[, options]) from readline/promises
  const askPromise = readlinePromises.Interface.prototype.question;
  readlinePromises.Interface.prototype.question = /** @type {typeof askPromise} */ (
    /**
     * @this {Rl & import('node:readline/promises').Interface}
     * @param {string} query
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<string>}
     */
    function (query, options) {
      if (!isUsers(this) || options?.signal?.aborted) return /** @type {Promise<string>} */ (Reflect.apply(askPromise, this, [query, options]));
      const rl = this;
      const prompt = String(query);
      return new Promise((resolve, reject) => {
        answer(rl, prompt, options?.signal, (signal, ok, fail) => {
          void askPromise.call(rl, query, { ...options, signal }).then(ok, fail);
        })
          .then((got) => {
            if (got.eof) return ended(rl, got);
            if (options?.signal?.aborted) return reject(options.signal.reason);
            if (got.served) show(rl, prompt, got.text, got.asked);
            resolve(got.text);
          })
          .catch(reject);
      });
    }
  );

  // for await (const line of rl)
  const proto = /** @type {{ [Symbol.asyncIterator]?: (this: Rl) => AsyncIterator<string> }} */ (Object.getPrototypeOf(readline.Interface.prototype));
  const iterate = proto[Symbol.asyncIterator];
  if (typeof iterate === 'function') {
    /** @this {Rl} */
    proto[Symbol.asyncIterator] = function () {
      if (!isUsers(this)) return iterate.call(this);
      const rl = this;
      // Node's own iterator queues every line from the moment the loop starts; so does this one,
      // when someone may type.
      const lines = origin === 'person' && !rl.closed ? iterate.call(rl) : null;
      let finished = false;
      /** @returns {Promise<Read>} */
      const readLive = () => {
        if (!lines) {
          endInput(rl);
          return Promise.resolve({ eof: true });
        }
        return lines.next().then(
          (r) => (r.done ? { eof: true } : { text: r.value }),
          () => ({ eof: true }),
        );
      };
      return {
        async next() {
          if (finished) return { value: undefined, done: true };
          const got = await userInput('', readLive);
          if (got.eof) {
            finished = true;
            ended(rl, got);
            return { value: undefined, done: true };
          }
          return { value: got.text, done: false };
        },
        async return() {
          finished = true;
          // Leaving the loop closes the interface, as Node's own iterator does.
          await lines?.return?.();
          rl.close();
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
  }

  syncBuiltinESMExports();
}
