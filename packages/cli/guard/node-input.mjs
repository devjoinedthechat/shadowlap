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
import { syncBuiltinESMExports } from 'node:module';
import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { isatty } from 'node:tty';

const sidecarUrl = process.env.SHADOWLAP_URL;
const runId = process.env.SHADOWLAP_RUN_ID;

/** Whether fd 0 is the input Shadowlap gave the agent, and whether nobody can type on it. */
function stdinOrigin() {
  try {
    if (isatty(0)) return 'person';
    // Exact and unsigned, as the CLI writes SHADOWLAP_STDIN: a pipe's inode can be beyond a double's
    // precision, and Node's big integers for it are signed.
    const unsigned = (n) => (n < 0n ? n + (1n << 64n) : n);
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

const origin = sidecarUrl && !globalThis.__shadowlapInput ? stdinOrigin() : null;

if (origin) {
  globalThis.__shadowlapInput = true;
  const base = sidecarUrl.replace(/\/$/, '');
  const send = globalThis.fetch;
  const baseScope = (() => {
    const raw = process.env.SHADOWLAP_SCOPE?.trim();
    return raw && raw.length <= 200 && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : undefined;
  })();

  async function post(path, body) {
    const headers = { 'content-type': 'application/json', 'user-agent': 'shadowlap-input-node' };
    if (runId) headers['x-shadowlap-run'] = runId;
    const scope = globalThis[Symbol.for('shadowlap.scope')]?.getStore?.() ?? baseScope;
    // % and anything outside printable ASCII percent-encoded, as the SDK sends it: a header holds Latin-1 at most.
    if (scope) headers['x-shadowlap-scope'] = scope.replace(/[^\x20-\x24\x26-\x7e]/gu, (c) => {
      try {
        return encodeURIComponent(c);
      } catch {
        return '%EF%BF%BD';
      }
    });
    const res = await send(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) {
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

  /** The text of a recorded answer: `{ text }`, or a bare string from an override. */
  const textOf = (result) => (typeof result === 'string' ? result : result && typeof result.text === 'string' ? result.text : result == null ? '' : JSON.stringify(result));

  /**
   * One person's answer: from the recording when the replay has it, else read live and recorded.
   * `readLive` resolves `{ text }`, or `{ eof: true }` when the input ended. Resolves
   * `{ text, served }` or `{ eof: true, served }`.
   */
  async function userInput(prompt, readLive) {
    const r = await post('/v1/calls/resolve', { kind: 'tool', name: 'user_input', effect: 'read', args: { prompt }, input: true });
    if (r.origin === 'replayed') return r.outcome === 'ok' ? { text: textOf(r.result), served: true } : { eof: true, served: true };
    if (r.origin !== 'live') throw new Error(`shadowlap: unexpected origin ${r.origin} for user input`);
    const started = Date.now();
    let got;
    try {
      got = await readLive();
    } catch (err) {
      await post(`/v1/calls/${r.callNo}/complete`, { outcome: 'error', error: { name: err?.name ?? 'Error', message: String(err?.message ?? err) }, latencyMs: Date.now() - started });
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
  const deferred = new WeakSet();
  const endInput = (rl) => {
    if (deferred.has(rl.input) && !rl.input.writableEnded) rl.input.end();
  };
  // userInput() from the SDK records its own answer, so a readline read inside it is not recorded
  // again; with no one at the keyboard it gets the input's end, as it would have.
  const direct = () => globalThis[Symbol.for('shadowlap.input.direct')]?.getStore?.() === true;
  const isUsers = (rl) => {
    if (rl.input !== process.stdin && !deferred.has(rl.input)) return false;
    if (!direct()) return true;
    endInput(rl);
    return false;
  };

  /** A served answer as the terminal would have shown it: the prompt (unless the real question showed it), and the line as if typed. */
  function show(rl, prompt, text, asked) {
    const out = rl.output;
    if (!out || typeof out.write !== 'function') return;
    if (prompt && !asked) out.write(prompt);
    if (out.isTTY && text !== null) out.write(`${text}\n`);
  }

  /** The next line someone types, or `{ eof: true }` when the interface closes first. */
  function liveLine(rl, ask) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn) => (value) => {
        if (settled) return;
        settled = true;
        rl.off('close', onClose);
        fn(value);
      };
      const onClose = settle(() => resolve({ eof: true }));
      if (rl.closed) return onClose();
      rl.once('close', onClose);
      ask(settle((text) => resolve({ text })), settle(reject));
    });
  }

  /**
   * One question a person answers. Node hands the next line to a question from the moment it is
   * asked, so when someone may type, the real question is asked at once, as Node would, and withdrawn
   * if the recording answers it. `askReal(signal, ok, fail)` asks it. Resolves
   * `{ text, served, asked }` or `{ eof: true, served, asked }`.
   */
  function answer(rl, prompt, userSignal, askReal) {
    let live = null;
    const controller = new AbortController();
    if (origin === 'person' && !rl.closed) {
      if (userSignal) userSignal.addEventListener('abort', () => controller.abort(userSignal.reason), { once: true });
      live = liveLine(rl, (ok, fail) => askReal(controller.signal, ok, fail));
      // A withdrawn question rejects; nothing waits on it then.
      live.catch(() => {});
    }
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

  /** The input ended: as with Node's own question, the answer never comes and the interface closes. */
  function ended(rl, got) {
    endInput(rl);
    if (got.served) rl.close();
  }

  function substitute(input) {
    if (origin !== 'nobody' || input !== process.stdin) return input;
    const proxy = new PassThrough();
    deferred.add(proxy);
    return proxy;
  }

  function watchForLineReaders(rl) {
    if (!deferred.has(rl.input)) return rl;
    // 'line' events are not recorded: an agent reading them gets the input's end at once, as it would have.
    const check = (event) => event === 'line' && endInput(rl);
    rl.on('newListener', check);
    setImmediate(() => rl.listenerCount('line') && endInput(rl));
    return rl;
  }

  for (const mod of [readline, readlinePromises]) {
    const create = mod.createInterface;
    mod.createInterface = function createInterface(input, ...rest) {
      if (input && typeof input === 'object' && 'input' in input && !(typeof input.on === 'function')) return watchForLineReaders(create.call(this, { ...input, input: substitute(input.input) }, ...rest));
      return watchForLineReaders(create.call(this, substitute(input), ...rest));
    };
  }

  // rl.question(query[, options], callback)
  const question = readline.Interface.prototype.question;
  const recordedQuestion = function (query, options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = undefined;
    }
    if (!isUsers(this) || typeof cb !== 'function' || options?.signal?.aborted) return question.call(this, query, options ?? {}, cb);
    const rl = this;
    const prompt = String(query);
    answer(rl, prompt, options?.signal, (signal, ok) => question.call(rl, query, { ...options, signal }, ok))
      .then((got) => {
        if (got.eof) return ended(rl, got);
        if (got.served) show(rl, prompt, got.text, got.asked);
        cb(got.text);
      })
      .catch((err) => process.nextTick(() => rl.emit('error', err)));
  };
  // util.promisify(rl.question) resolves with the answer, as Node's own question does.
  recordedQuestion[Symbol.for('nodejs.util.promisify.custom')] = function (query, options) {
    return new Promise((resolve) => recordedQuestion.call(this, query, options ?? {}, resolve));
  };
  readline.Interface.prototype.question = recordedQuestion;

  // await rl.question(query[, options]) from readline/promises
  const askPromise = readlinePromises.Interface.prototype.question;
  readlinePromises.Interface.prototype.question = function (query, options) {
    if (!isUsers(this) || options?.signal?.aborted) return askPromise.call(this, query, options);
    const rl = this;
    const prompt = String(query);
    return new Promise((resolve, reject) => {
      answer(rl, prompt, options?.signal, (signal, ok, fail) => askPromise.call(rl, query, { ...options, signal }).then(ok, fail))
        .then((got) => {
          if (got.eof) return ended(rl, got);
          if (options?.signal?.aborted) return reject(options.signal.reason);
          if (got.served) show(rl, prompt, got.text, got.asked);
          resolve(got.text);
        })
        .catch(reject);
    });
  };

  // for await (const line of rl)
  const proto = Object.getPrototypeOf(readline.Interface.prototype);
  const iterate = proto[Symbol.asyncIterator];
  if (typeof iterate === 'function') {
    proto[Symbol.asyncIterator] = function () {
      if (!isUsers(this)) return iterate.call(this);
      const rl = this;
      // Node's own iterator queues every line from the moment the loop starts; so does this one,
      // when someone may type.
      const lines = origin === 'person' && !rl.closed ? iterate.call(rl) : null;
      let finished = false;
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
