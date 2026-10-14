// What every Shadowlap SDK must do, as scenarios a client program performs and assertions on what
// the sidecar recorded. See docs/protocol.md; the client contract is in README.md.
import assert from 'node:assert/strict';

const tools = (calls) => calls.filter((c) => c.kind === 'tool');
const one = (calls, name) => {
  const found = tools(calls).filter((c) => c.name === name);
  assert.equal(found.length, 1, `expected exactly one ${name} call, got ${found.length}`);
  return found[0];
};
const resultOf = (store, call) => (call.end?.responseRef ? store.getJson(call.end.responseRef) : null);

/**
 * `record` and `replay` name the step the client program is asked to perform. `env` adds variables
 * for it, `replayOptions` are merged into the replay run, and `check` throws on any deviation.
 */
export const SCENARIOS = [
  {
    name: 'live-ok',
    why: 'a read tool during a recording runs for real and is completed with its result',
    record: 'live-ok',
    check({ recordOut, recordCalls, store }) {
      assert.deepEqual(recordOut.result, { got: 1 }, 'the tool wrapper must return what the implementation returned');
      assert.equal(recordOut.implRuns, 1, 'the implementation must run exactly once while recording');
      const call = one(recordCalls, 'echo');
      assert.equal(call.effect, 'read');
      assert.equal(call.origin, 'live');
      assert.equal(call.end?.outcome, 'ok', 'the call must be completed, not left pending');
      assert.deepEqual(resultOf(store, call).result, { got: 1 }, 'the recorded result must be the real one');
    },
  },
  {
    name: 'live-error',
    why: 'a tool that throws is completed with outcome error, and the error still reaches the caller',
    record: 'live-error',
    check({ recordOut, recordCalls }) {
      assert.equal(recordOut.implRuns, 1);
      assert.equal(recordOut.caught?.message, 'boom', 'the original error must propagate to the caller');
      const call = one(recordCalls, 'boom');
      assert.equal(call.end?.outcome, 'error', 'a throwing tool must still be completed');
      assert.equal(call.end?.meta.error?.message, 'boom', 'the serialized error must carry the message');
    },
  },
  {
    name: 'replay-ok',
    why: 'a replayed tool returns the recorded result without running the implementation',
    record: 'live-ok',
    replay: 'live-ok',
    check({ replayOut, replayCalls }) {
      assert.deepEqual(replayOut.result, { got: 1 }, 'replay must return the recorded result');
      assert.equal(replayOut.implRuns, 0, 'the implementation MUST NOT run on a replayed call');
      assert.equal(one(replayCalls, 'echo').origin, 'replayed');
    },
  },
  {
    name: 'replay-error',
    why: 'a recorded error is raised again as a replayed error, without running the implementation',
    record: 'live-error',
    replay: 'live-error',
    check({ replayOut, replayCalls }) {
      assert.equal(replayOut.implRuns, 0, 'the implementation MUST NOT run for a replayed error');
      assert.equal(replayOut.caught?.message, 'boom', 'the recorded message must be raised again');
      assert.equal(replayOut.caught?.replayed, true, 'a replayed error must be a distinct type the caller can catch');
      assert.equal(one(replayCalls, 'boom').origin, 'replayed');
    },
  },
  {
    name: 'unserializable-result',
    why: 'a result that cannot become JSON still completes the call, so the recording has no hole',
    record: 'unserializable',
    check({ recordOut, recordCalls }) {
      assert.equal(recordOut.raised, true, 'the caller must see the failure, not a silent null');
      const call = recordCalls.find((c) => c.name === 'weird');
      assert.ok(call, 'the call must reach the sidecar');
      assert.ok(call.end, 'the call was left pending: a replay would have no answer for it');
      assert.equal(call.end.outcome, 'error', 'an unserializable result is an error outcome');
    },
  },
  {
    name: 'clock-random',
    why: 'clock and randomness resolve in one round trip and replay to the same values',
    record: 'clock-random',
    replay: 'clock-random',
    check({ recordOut, replayOut, recordCalls }) {
      assert.equal(typeof recordOut.now, 'number');
      assert.equal(typeof recordOut.random, 'number');
      assert.equal(typeof recordOut.uuid, 'string');
      assert.equal(replayOut.now, recordOut.now, 'the clock must replay to the recorded value');
      assert.equal(replayOut.random, recordOut.random, 'randomness must replay to the recorded value');
      assert.equal(replayOut.uuid, recordOut.uuid, 'uuid must replay to the recorded value');
      const kinds = recordCalls.filter((c) => c.kind === 'clock' || c.kind === 'random');
      assert.equal(kinds.length, 3, 'three reads must be recorded');
      for (const c of kinds) assert.equal(c.end?.outcome, 'ok', 'clock and random need no separate complete');
    },
  },
  {
    name: 'scope',
    why: 'identical calls in parallel branches keep their own answers, whatever order they replay in',
    record: 'scope-record',
    replay: 'scope-replay',
    check({ recordOut, replayOut, recordCalls }) {
      assert.deepEqual(recordOut, { a: 'a', b: 'b' }, 'each branch records the value it produced');
      const scopes = tools(recordCalls).map((c) => c.meta.scope).sort();
      assert.deepEqual(scopes, ['a', 'b'], 'each call must carry x-shadowlap-scope; got ' + JSON.stringify(scopes));
      // The replay asks for b first, then a. Without scopes the two swap answers.
      assert.deepEqual(replayOut, { a: 'a', b: 'b' }, 'branches swapped answers on replay: scopes are not being sent');
    },
  },
  {
    name: 'base-scope',
    why: 'SHADOWLAP_SCOPE names the branch of a process, so separate processes keep their own answers',
    record: 'base-scope',
    env: { SHADOWLAP_SCOPE: 'worker-2' },
    check({ recordOut, recordCalls }) {
      assert.deepEqual(recordOut.scopes, ['worker-2', 'worker-2/inner'], 'the process starts in the scope the variable names, and code scopes nest under it');
      const scopes = tools(recordCalls).map((c) => c.meta.scope);
      assert.deepEqual(scopes, ['worker-2', 'worker-2/inner'], 'every call must carry it; got ' + JSON.stringify(scopes));
    },
  },
  {
    name: 'blocked',
    why: 'a write tool reached after a fork raises write-blocked and never runs',
    record: 'write',
    replay: 'write',
    replayOptions: { divergeAt: 1, writes: 'block' },
    check({ replayOut, replayCalls }) {
      assert.equal(replayOut.implRuns, 0, 'a blocked write MUST NOT run its implementation');
      assert.equal(replayOut.blocked, true, 'a blocked write must raise a distinct write-blocked type');
      assert.equal(replayOut.tool, 'send', 'the write-blocked error must name the tool');
      assert.equal(one(replayCalls, 'send').origin, 'blocked');
    },
  },
  {
    name: 'stubbed',
    why: 'under --writes stub the stub value is returned and recorded, and the implementation never runs',
    record: 'write',
    replay: 'write',
    replayOptions: { divergeAt: 1, writes: 'stub' },
    check({ replayOut, replayCalls, store }) {
      assert.equal(replayOut.implRuns, 0, 'a stubbed write MUST NOT run its implementation');
      assert.equal(replayOut.result, 'stub', 'the stub value must be returned to the caller');
      const call = one(replayCalls, 'send');
      assert.equal(call.origin, 'stubbed');
      assert.equal(call.end?.outcome, 'ok', 'a stubbed call must still be completed');
      assert.equal(resultOf(store, call).result, 'stub', 'the stub value must be recorded');
    },
  },
  {
    name: 'impl-hash',
    why: 'a changed implementation is reported but never changes what a call matches',
    record: 'impl-hash-a',
    replay: 'impl-hash-b',
    check({ recordCalls, replayCalls, replayOut }) {
      const before = one(recordCalls, 'stable').meta.implHash;
      const after = one(replayCalls, 'stable').meta.implHash;
      assert.ok(before, 'the client should send implHash so a changed tool can be reported');
      assert.notEqual(after, before, 'a changed implementation must produce a different implHash');
      assert.equal(one(replayCalls, 'stable').origin, 'replayed', 'implHash must take no part in matching');
      assert.equal(replayOut.implRuns, 0);
    },
  },
  {
    name: 'reads-after-fork',
    why: 'with --reads replay a read tool is still served from the recording after a fork',
    record: 'reads',
    replay: 'reads',
    replayOptions: { divergeAt: 1, reads: 'replay' },
    check({ replayOut, replayCalls }) {
      assert.equal(one(replayCalls, 'fetchit').origin, 'replayed', 'a read must come from the recording under --reads replay');
      assert.equal(replayOut.implRuns, 0, 'the read implementation must not run when it is served from the recording');
      assert.equal(replayOut.result, 'from-impl');
    },
  },
  {
    name: 'inactive',
    why: 'with no SHADOWLAP_URL the wrappers are transparent: the real code runs and nothing is recorded',
    inactive: 'live-ok',
    check({ recordOut }) {
      assert.equal(recordOut.active, false, 'the client must report Shadowlap as inactive');
      assert.equal(recordOut.implRuns, 1, 'the implementation must run normally outside Shadowlap');
      assert.deepEqual(recordOut.result, { got: 1 });
    },
  },
  {
    name: 'bad-effect',
    why: 'an invalid effect is rejected locally, before any request reaches the sidecar',
    record: 'bad-effect',
    check({ recordOut, recordCalls }) {
      assert.equal(recordOut.rejected, true, 'declaring a tool with an invalid effect must fail');
      assert.equal(tools(recordCalls).length, 0, 'nothing may be sent to the sidecar for an invalid effect');
    },
  },
];
