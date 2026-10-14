// The TypeScript SDK as a client under test. One step per invocation, named by argv[2]; the result
// is one JSON object on stdout. See ../../README.md for the contract a new client implements.
import { currentScope, ShadowlapWriteBlocked, isActive, now, random, ReplayedError, scope, tool, uuid } from '../../../../packages/sdk/dist/index.js';

const step = process.argv[2];
const out = (o) => console.log(JSON.stringify(o));
let implRuns = 0;

const echo = tool('echo', { effect: 'read' }, (args) => {
  implRuns++;
  return { got: args.n };
});

const boom = tool('boom', { effect: 'read' }, () => {
  implRuns++;
  throw new Error('boom');
});

const pick = tool('pick', { effect: 'pure' }, () => {
  implRuns++;
  // Recorded: each branch produces its own value. Replayed: this never runs.
  return currentBranch;
});
let currentBranch = null;

const ping = tool('ping', { effect: 'pure' }, () => 'pong');
const send = tool('send', { effect: 'write', onFork: () => 'stub' }, () => {
  implRuns++;
  return 'sent';
});

switch (step) {
  case 'live-ok': {
    const result = await echo({ n: 1 });
    out({ result, implRuns, active: isActive() });
    break;
  }
  case 'live-error': {
    try {
      await boom({});
      out({ caught: null, implRuns });
    } catch (err) {
      out({ caught: { name: err.name, message: err.message, replayed: err instanceof ReplayedError }, implRuns });
    }
    break;
  }
  case 'unserializable': {
    const circular = tool('weird', { effect: 'read' }, () => {
      implRuns++;
      const o = {};
      o.self = o; // JSON.stringify throws on this
      return o;
    });
    try {
      await circular({});
      out({ raised: false, implRuns });
    } catch {
      out({ raised: true, implRuns });
    }
    break;
  }
  case 'clock-random': {
    out({ now: await now(), random: await random(), uuid: await uuid() });
    break;
  }
  case 'scope-record': {
    const a = await scope('a', () => ((currentBranch = 'a'), pick({})));
    const b = await scope('b', () => ((currentBranch = 'b'), pick({})));
    out({ a, b });
    break;
  }
  case 'scope-replay': {
    // Reverse order on purpose: without scopes the two branches swap answers.
    const b = await scope('b', () => ((currentBranch = 'b'), pick({})));
    const a = await scope('a', () => ((currentBranch = 'a'), pick({})));
    out({ a, b });
    break;
  }
  case 'impl-hash-a':
  case 'impl-hash-b': {
    // Same name, same arguments, different source: only the implHash may differ.
    const stable =
      step === 'impl-hash-a'
        ? tool('stable', { effect: 'read' }, () => (implRuns++, 'value'))
        : tool('stable', { effect: 'read' }, () => {
            implRuns++;
            return 'value'; // rewritten body, same behaviour
          });
    out({ result: await stable({ k: 1 }), implRuns });
    break;
  }
  case 'reads': {
    const fetchit = tool('fetchit', { effect: 'read' }, () => (implRuns++, 'from-impl'));
    await ping({});
    out({ result: await fetchit({ q: 'x' }), implRuns });
    break;
  }
  case 'base-scope': {
    // No scope entered in code: whatever the process starts in comes from the environment.
    const outer = currentScope();
    await echo({ n: 1 });
    const inner = await scope('inner', async () => {
      const seen = currentScope();
      await echo({ n: 2 });
      return seen;
    });
    out({ scopes: [outer, inner] });
    break;
  }
  case 'write': {
    await ping({});
    try {
      const result = await send({ to: 'ops' });
      out({ result, implRuns, blocked: false });
    } catch (err) {
      if (err instanceof ShadowlapWriteBlocked) out({ blocked: true, tool: err.tool, implRuns });
      else out({ blocked: false, error: err.message, implRuns });
    }
    break;
  }
  case 'bad-effect': {
    try {
      tool('nope', { effect: 'nope' }, () => null);
      out({ rejected: false });
    } catch {
      out({ rejected: true });
    }
    break;
  }
  case 'fail': {
    // Recorded, the tool answers; replayed under --fail-at, it must fail without running.
    try {
      out({ result: await echo({ n: 1 }), caught: null, implRuns });
    } catch (err) {
      out({ caught: { name: err.name, message: err.message, injected: err.injected === true, timeout: err.name === 'TimeoutError', status: err.status ?? null }, implRuns });
    }
    break;
  }
  default:
    out({ error: `unknown step ${step}` });
    process.exitCode = 1;
}
