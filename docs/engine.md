# The engine as a library

`@shadowlap/engine` is the package the CLI, the sidecar, the dashboard and the terminal UI are all
built on. It is exported, versioned with the rest, and usable on its own — to build an importer, a
different viewer, a custom CI integration, or anything else that needs to read recordings.

Nothing here talks to a network or a model provider. It is a SQLite store, a fingerprinting
function, a replay state machine and the reports around them.

> For writing an SDK in another language, you want [the wire protocol](./protocol.md) instead.
> This page is for programs that read and write recordings directly.

```ts
import { Store, summarizeRun } from '@shadowlap/engine';

const store = Store.open('./.shadowlap/shadowlap.db');
const run = store.findRun('01K5CQ');            // by id or unique prefix
const calls = store.getCalls(run.runId);
console.log(summarizeRun(run, calls).byOrigin); // { live: 11, replayed: 18, blocked: 1, … }
store.close();
```

Until the npm release, import from the build output: `packages/engine/dist/index.js`.

## The store

One SQLite file holding runs, call events and content-addressed blobs. Every method is synchronous.

```ts
Store.open(path: string): Store        // ':memory:' for a throwaway store
store.close(): void
```

**Reading**

| | |
|---|---|
| `getRun(runId)` | One run, or `null`. |
| `findRun(idOrPrefix)` | By full id or unique prefix — what the CLI accepts. |
| `listRuns(limit?)` / `allRuns()` | Newest first. |
| `childRuns(runId)` | The forks of a run. |
| `getCalls(runId)` | Every call as a `CallRecord`: the start row, the final end row, earlier attempts. |
| `countCalls(runId)` | Without loading them. |
| `getBlob(hash)` / `getJson(ref)` | Stored request and response bodies. |

**Writing** — `createRun`, `importRun`, `appendCallStart`, `appendCallEnd`, `endRun`,
`setDivergence`, `updateRunMeta`, `putBlob`, `putJson`, `deleteRun`, `gcBlobs`, `vacuum`.

Writing calls directly is the low-level path. **Prefer building a pack**: it is validated, it
verifies blob hashes, and it is the same door the CLI uses for recordings from elsewhere.

## Packs: the supported way in

A pack is a directory — `run.json`, `calls.jsonl`, one uncompressed file per blob under `blobs/` —
with stable names, so it is diffable and committable. [The recording format](./recording-format.md)
specifies it, for a program that writes packs without this library.

```ts
packRun(source: Store, runId: string, dir: string, opts?: { lineage?: boolean; redact?: Normalizer[] }): PackResult
unpackRun(store: Store, dir: string): { imported: string[]; skipped: string[]; commands: Array<{ runId: string; argv: string[] }> }
commandIsImported(run): boolean     // its command came from a pack or the team store: replaying it needs consent
importedCommandSource(run)          // 'the team store' for a pulled run (pulledRun), else 'an imported pack'
hasRecordedCommand(run): boolean    // false for a run built from a capture, whose command is NO_COMMAND
```

`unpackRun` treats its input as hostile: every record is checked for type, range and shape before
anything reaches the store, every blob is verified against its hash, and every blob a call needs
must be present. The limits are in `PACK_LIMITS` and failures throw `PackError`.

**If you are writing an importer, prefer the pack format.** Convert your source into a pack
directory and call `unpackRun`, and you inherit every check for free instead of adding a second way
into the store.

Writing calls directly is reasonable when the importer computes the fields that matter — which is
what `shadowlap import` does, since it derives every id, fingerprint and occurrence itself rather
than reading them from the file. The obligation that comes with that route is the one `unpackRun`
would have discharged: **anything taken verbatim from the source is untrusted**. Escape it with
`safeText` or `safeLine` before it reaches metadata that a terminal or the dashboard will render,
and bound its length, because nothing else will.

A capture never knew what started the agent, so give such a run `NO_COMMAND` as its command, mark it
`meta.imported`, and list the kinds of call it holds in `meta.covers`. Every command that would
start the agent then asks for one instead of running the placeholder.

## Identity and matching

A call's identity is `(kind, fingerprint, occurrence)`. Arrival order never takes part, which is
why parallel tool calls replay in any interleaving.

```ts
fingerprintApi(req: ApiRequestShape, normalizers, allowHeaders, clock?, opts?): { fingerprint, canonical }
fingerprintTool(name: string, args: unknown, normalizers, clock?): { fingerprint, canonical }
fingerprintMisc(kind: 'clock' | 'random', label: string): { fingerprint, canonical }
normalizersHash(normalizers, clock?, withoutPromptMask?): string
```

The fingerprint is a SHA-256 over the canonical form of the request after normalizers. For an API
call that is `{ method, path, allowlisted headers, body }` — so an importer that reconstructs a
request body inexactly will not match on replay, however close it looks. `canonicalize` is exported
if you need the same canonical JSON yourself.

`normalizersHash` identifies the fingerprinting a run's stored fingerprints are valid under; a
replay under the same list can reuse them instead of recomputing.

## Normalizers

A `Normalizer` masks values before fingerprinting (so a request id made on every run does not fork it) and
doubles as a redaction rule on export — the same shape, because a redacted recording still has to
match a live request.

```ts
applyNormalizers(value, normalizers, kind, name): unknown
proposeNormalizers(d: DivergenceReport, existing?): CalibrationStep   // what `shadowlap calibrate` suggests
covered(entry, kind, name, normalizers): boolean
generalize(before: string, after: string): string | null
compilePattern, namedPatterns, parsePath, rewriteStringsDeep, stripKeysDeep
```

`proposeNormalizers` is the interesting one: given a divergence, it works out which differences are
generated values and proposes rules for them.

## Diffs, comparisons and reports

```ts
structuralDiff(before, after, path?): DiffEntry[]      // what a fork report is built from
firstDifference(a: string, b: string): number
hintsFor(entry, kind, name?): Hint[]                   // "this looks like a date"
compareRuns(store, a, aCalls, b, bCalls): RunComparison
runChanges(store, a, aCalls, b, bCalls): RunChanges    // system prompt, tools, model, code version
runsDiffer(c): boolean
summarizeRun(run, calls, notReached?, warnings?, options?): RunSummary
formatSummary(s, palette?) / formatDivergence(d, palette?) / formatComparison(c, palette?): string
```

The `format*` functions render for a terminal. Pass `plain` as the palette for output with no
escape codes — that is what the JSON and CI paths use.

## Cost, datasets and search

```ts
estimateCost(model, usage, prices?): number | null
priceFor(model, prices?) / canonicalModel(model) / shortModel(model) / formatUsd / formatDuration
DEFAULT_PRICES: Record<string, Price>                  // USD per million tokens, by model prefix

datasetRows(store, runs, opts): unknown[]              // jsonl | openai-chat | braintrust | langfuse

updateSearchIndex(store): number                       // indexes what is new; safe to call often
searchCalls(store, query, opts?): SearchHit[]
```

## Gates

Verdicts on attempts that vary, as `test`'s gate, `verify` and `blame` decide them ([gating](./gating.md)). Pure functions:

```ts
// { kind: 'sprt', good, bad, risk, max } | { kind: 'baseline', drop, risk, window, min, max }
parseGate(json, where, defaults?): Gate
// 'pass' | 'fail' | 'continue' | 'inconclusive'; a baseline gate without history
// compares with the recording (RECORDING_BASELINE, one attempt that passed)
decide(passes, attempts, gate, history?)
// the decision, each outcome, the interval, pass^k, the evidence path and the verdict line;
// `decision` freezes one reached before attempts still running ended, `carried` counts
// attempts a continued session took over
gateResult(gate, outcomes, { history?, clean?, decision?, carried?, unavailable? }): GateResult
// what a report says, never a claimed rate: the rule (`tells 90%+ from 70%- at <= 5% risk,
// up to 80 attempts`), the verdict word with the tally and the bound (`passed · 12 of 12
// · rate >= 0.73 (95%)`), the two as one line, the bound alone (`wilsonBound` is its old name),
// and the tally with pass^k
describeGate(gate) / verdictLine(result) / gateSentence(gate, result)
rateBound(result) / formatTally(result)
// the pass rate's interval at 1 − risk: exact under the gate's own stopping (`stagewise`), else a
// confidence sequence; from a tally alone; a fixed count's (Clopper–Pearson); and the end a verdict shows
gateInterval(gate, outcomes, { decision?, history?, carried?, clean? }) / tallyInterval(gate, tally, decision, history?)
clopperPearson(passes, n, confidence) / confidenceSequence(passes, n, confidence) / boundOf(interval, decision)
// a test session's one risk split across its gated goldens, each gate's share, and the forecast
planSuite(goldens, { risk?, inconclusive? }): SuitePlan | null
// whether a failed attempt's provider was unavailable, read from its call records, and the pause before a retry
providerUnavailable(calls): Unavailable | null / retryDelay(n, retryAfterMs)
// the exact odds of each verdict, and the attempts run on average, every look counted;
// `from` continues from a tally already seen
gateOdds(gate, p, history?, from?): GateOdds
gateOddsAt(gate, rates, history?): Array<GateOdds & { rate }>
// the share of CI runs of n goldens that go red for nothing, under --inconclusive fail or warn
runsRed(odds, goldens, mode?)
wilson(passes, n, confidence) / passHatK(c, n, k) / binomialTail(n, k, p)
sprtBounds(gate) / sprtStep(score, passed, gate) / attemptsToPass(gate)
// P(now < baseline − drop), each a Beta posterior
dropProbability(now, baseline, drop)
// a golden's baseline, pooled from its test history: only results that passed on the baseline
// branch (`branch`, else each result's own), for no pull request, on a committed revision;
// excludeSession takes one id or several
gateHistory(store, golden, { window, branch?, goldenRunId?, checks?, mode?, excludeSession?, before? })
```

## The replay state machine

`Session` is what the sidecar drives; you need it only if you are re-implementing replay itself.

```ts
const session = new Session(opts);
const decision = session.resolve({ callNo, kind, name, fingerprint, effect?, request?, scope? });
// decision.origin: 'live' | 'replayed' | 'blocked' | 'stubbed' | 'overridden'
session.divergence;   // the DivergenceReport, once one has happened
```

`ReplayOptions` are `writes`, `reads`, `liveTools`, `divergeAt`, `promptFrom` and `overrides`;
`DEFAULT_REPLAY_OPTIONS` is block-writes, live-reads, nothing forced. The semantics each origin
implies for a caller are specified in [the wire protocol](./protocol.md#endpoints).

## Stability

`SCHEMA_VERSION` is the store schema; `PACK_VERSION` and `PACK_FORMAT` identify the pack format;
`FINGERPRINT_VERSION` changes when fingerprints would no longer match across versions.

The engine is pre-1.0 and its surface may change. The pack format is the most stable thing here and
the one to build on where you have the choice.
