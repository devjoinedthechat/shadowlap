# @shadowlap/engine

The library [Shadowlap](https://github.com/devjoinedthechat/shadowlap)'s CLI, sidecar, dashboard and terminal UI are built on: the SQLite store, packs, fingerprints and matching, normalizers, diffs and reports, gates, and the replay state machine.

```sh
npm install @shadowlap/engine
```

```ts
import { Store, summarizeRun } from '@shadowlap/engine';

const store = Store.open('.shadowlap/shadowlap.db');
const run = store.findRun('01M5AQ6Q1G');       // a run id, or a unique prefix of one
if (run) {
  const summary = summarizeRun(run, store.getCalls(run.runId));
  console.log(summary.byKind);                  // { api: 5, tool: 4, clock: 0, random: 0 }
}
store.close();
```

Nothing in it talks to a network or a model provider. To bring recordings from another tool, write a pack and read it with `unpackRun`, which checks every record and every blob's hash before anything reaches the store. Node 22.13 or later, no dependencies.

[The engine as a library](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/engine.md) · [The recording format](https://github.com/devjoinedthechat/shadowlap/blob/main/docs/recording-format.md)
