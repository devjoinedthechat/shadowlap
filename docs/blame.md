# Blame

A run usually goes wrong well before it visibly fails. The agent refunds an order it should have escalated, and the run only looks wrong at the end, when the refund is already issued. `shadowlap blame` finds the model call that lost the run: the last one whose answer, asked again, lets the run pass.

```sh
shadowlap blame <run> --expect '{"tools":{"issue_refund":0}}'
```

```
⑂ The run was lost at model call #5 (3 of 4)
  The re-asked call #5: rescued · 5 of 10 · rate >= 0.10 (99%); #7, the next model call: lost · 0 of 6 · rate <= 0.59 (99%).
  Checked with 20 fresh pairs: #5 rescued 10 of 20, #7 0 of 20; rescue drops at #5 beyond chance.
  Confidence: high (<= 2.9% risk that the call is wrong: 3 probes decided, at <= 0.8% risk each, and the check of #5, at <= 0.6%)

  At #5  the recording   issue_refund({"order_id":"A-1042","amount":240})
         a rescued fork  "Above the limit.", escalate({"reason":"refund of $240 is above $100"})

  Probes (gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 31 attempts;
          resample the probed call)
    #1  1 of 4  4 of 7 passed · rate >= 0.11 (99%)   rescued
    #5  3 of 4  5 of 10 passed · rate >= 0.10 (99%)  rescued  ◂ blamed
    #7  4 of 4  0 of 6 passed · rate <= 0.59 (99%)   lost

  63 attempts · 114 upstream requests · ≈$0 spent (no price for small-model) · every call before a probe replayed from the recording
  oracle: the agent exits 0; issue_refund called 0 times
  rescued fork: shadowlap diff 01M3R1YKHF 01M3R1YMHF    shadowlap ui 01M3R1YMHF --call 5
…
```

It found the call by forking the run, not by reading it: every call before a probe came from the recording for free, and only the rest ran live, with writes fenced. Before saying the run was lost at #5, it checked #5 against #7 with fresh pairs of attempts: rescue drops there, so the one call is named ([the check](#how-it-works)).

## How it works

**The oracle** says what a passing run does. By default it is the agent's exit code: a run passes when the agent exits 0. `--expect` adds [outcome checks](./ci.md#outcome-checks), the same object `expect` takes under `tests` in `shadowlap.config.json`: which tools must or must not be called and with what arguments, call counts, token and cost budgets, text in the output or the final answer.

**The baseline.** Blame first replays the run as recorded. That costs nothing, and it must reproduce the failure: the replay has to be clean, and it has to fail the oracle. A run that passes has nothing to blame; one whose replay forks by itself would make every probe ambiguous, so blame refuses it and points to [`shadowlap calibrate`](./normalizers-and-redaction.md#calibrate).

**A probe** asks one question of one model call *k*: if the model had answered *k* differently, could the run still have passed? It replays the calls before *k* from the recording, forces *k* live, and lets the rest of the run go live. It does this several times, because one lucky sample proves nothing, and decides after each attempt with a [gate](./gating.md) that tells a re-asked call that passes 60% of the time or more, which **rescues** the run, from one that passes 10% or less, where the run is **lost**. A rescue claims the call passes more than 10% of the time, a loss that it passes less than 60%, and each claim can be wrong only that probe's share of the gate's risk: the risk is the whole search's, 5%, split over the most probes the search makes (below), so every claim of every probe holds together but for it. Between the two rates either verdict can come, so a probe says what it found as its verdict, its tally and the bound at its own confidence, exact under the gate's stopping ([reading the evidence](./gating.md#reading-the-evidence)): `rescued · 5 of 10 · rate >= 0.10 (99%)`, and the report states the rule once, over the probes. At a share of 1% to 0.5% (a search of 5 to 10 probes), three straight passes rescue and six or seven straight failures lose; a mix takes more attempts, up to the gate's `max` deepened to the probe's share (20 at 5% becomes 31 to 36: as far into the evidence), and a probe still between the two after that is **inconclusive**, which claims nothing. So is a probe with an attempt that all it fell short on is a check that could not be decided, such as a judge whose call failed: that attempt is no failure of the answer, and no attempt after it would say more, so the probe stops there, and the report says which check and why. A provider that is down or overloaded says nothing about the answer either: an attempt the agent failed while one of its model calls ended on a 429, a 529 or another 5xx is run again and never counted when that came before the model answered anything, and counted against either verdict when it came after, a failure toward a rescue and a pass toward a loss ([gating](./gating.md#when-the-provider-is-unavailable)); when the provider stays unavailable three attempts in a row, blame stops there, *Stopped before the search finished: provider unavailable: …*, and exits 3. It never calls a run rescued, lost or unrescuable on what the provider never answered. `--gate '{"good":0.5}'` changes any of the figures (`good`, `bad`, `risk`, `max`); `--attempts` and `--passes` give a fixed count instead, which stops as soon as the attempts left can no longer change its verdict, and whose probes can be wrong as often as their count allows (2 of 5: 8.8% a probe). With `--concurrency`, a probe runs that many attempts at once and decides on them in the order they started, so an attempt that takes longer because it fails counts where it would have one after another. A new attempt starts only while fewer than that many have started that the probe hasn't counted: once that many have, the next waits for the earliest of them to end rather than start a live, paid fork the probe couldn't count yet, so with `--concurrency n` at most *n* − 1 attempts run past the one that decides. The probe's first verdict stands, and attempts still running when it came are listed with the probe but never reopen it.

**The search.** Rescue gets harder the later it starts: resampling from the first model call re-runs almost the whole agent, and resampling the last can only change the ending. So the rate at which resampling a call rescues the run falls as the calls go on, and the run was lost where it falls from rescuable to lost: the boundary, the calls from the last one rescued 60% of the time or more to the one before the first rescued 10% or less. A sharp drop makes it one call, a gradual one several. Blame probes the first model call, then binary-searches the rest, so a run with 30 model calls needs about six probes, not thirty; the most a search makes, `1 + ⌈log₂ m⌉ + scan` for *m* model calls, is what the risk is split over. Then **the run was lost between the last call that rescued it and the call before the first found lost after it**: one call when those two are neighbours and the check below finds rescue drops there (*the run was lost at model call #5*), else a range (*lost between model calls #7 and #9*), where the probes inside claimed nothing. That range holds a call of the boundary whenever every claim holds: the rescued call passes more than 10% of the time, so it comes before the first call at 10% or less; the call found lost passes less than 60%, so it comes after the last at 60% or more.

**The check of a pinned call.** The two claims that pin a call hold as well for two neighbours in the middle of a gradual decay as for a sharp drop: two calls that both pass 40% of the time are rescued and lost as readily. So before blame says the run was lost at a call, it checks the call against the next with fresh pairs of attempts, one at each call in every pair, and asks whether rescue drops there. It is the [paired test](./verify.md#good-runs-against-their-own-baseline) verify keeps a good run by, on the next call's attempt less the pinned call's: **pinned** once the call is rescued more often than the next beyond chance, **gradual** once it is shown rescued less than 50 points (the gate's two rates apart) more often, and neither after twice a probe's attempts in pairs. Pinned keeps *the run was lost at model call #5*, with the check under it: *Checked with 12 fresh pairs: #5 rescued 12 of 12, #6 0 of 12; rescue drops at #5 beyond chance.* Otherwise the range is the two calls, *the run was lost gradually, around model calls #17 and #18*, and no one call lost the run. The pairs are fresh because the probes' own tallies are what picked the call: read off them, a rescue and a loss look apart by selection alone. Each verdict is wrong at most a probe's share of the risk, over every way the pairs can come, and its exact risk joins the error bound; at the defaults the bound still keeps within 5% for a run of up to a million model calls. A sharp drop from 95% to 0 takes about 12 pairs, one from 60% to 10% about 24, and two neighbours both near 40% about 25. In the engine's simulation of a run whose rescue falls from 95% to 0 over calls 5 to 28 of 30, blame says with high confidence that the run was lost at one call 0.5% of the time, where unchecked it said so 71.5% of the time; sharp drops from 95% to 0 and from 60% to 10% are still pinned 100% and 98.1% of the time.

**The confidence** is read from the range's error bound, the sum of the exact risks of the probes that claimed something (`probeRisk`, each worked out over every look of its gate at its two rates), and of the check's when it found a drop or none: **high** when the range is wrong at most the gate's risk, 5%; **medium** within twice that or 20%; **low** beyond, or when nothing bounds it: the search stopped, the first probe couldn't tell, or rescue rose again past a call found lost by more than chance explains. A seeded simulation of the whole search in the engine's tests holds it to that: on sharp drops (0.95 to 0, 0.8 to 0.05, and 0.6 to 0.1, on the gate's own rates), gradual decays and runs no call rescues, whenever blame says high, the range holds the true boundary at least 98.7% of the time. The probes' rescue rates are also fitted non-increasing (isotonic regression), and where they rose as the calls went on the report says which probes the fit read as one rate.

**The scan.** Nothing guarantees rescue falls monotonely: a run can be rescuable at 10, not at 12, and again at 14. After the binary search, blame also probes the next few calls past the boundary (`--scan`, 2 by default), which also finds the call that closes a range when the call after the boundary was inconclusive. If one of them rescues the run past a call found lost, rescue rose again: the search moves on past it, its extra probes add their risks to the bound, and when the rise is more than chance explains (Fisher's exact test on the two probes, at the gate's risk), nothing bounds the location and the confidence is low.

## The rescue

By default a probe asks the model the same question again, with the request exactly as recorded, and relies on sampling to produce a different answer. At temperature 0 a model answers the same way every time, so add `--set temperature=1` to let a probe sample. The setting goes where the provider keeps it (Gemini's `generationConfig`, Bedrock Converse's `inferenceConfig`), so this works on every provider; see [patching parameters](./interventions.md#patch-parameters).

`--model` rescues with another model instead, from the probed call on:

```sh
shadowlap blame <run> --expect @checks.json --model claude-opus-5-5
```

When the first model call's probe finds the run lost, resampling from it, and so from any later call, rescues the run less than 60% of the time, and the report says **Not rescued from any model call**, when that holds but for the gate's risk; a fixed count, which can be wrong more often, says only *Not rescued from the first model call*. That is a finding, not an error: the failure is not one unlucky answer the model gets right most of the time. It comes from the prompt, the tools, the harness, or a task the model cannot do. Blame with a stronger model tells the last two apart. If `--model` finds a call and resampling did not, the model's capability is the problem; if neither finds one, look at the code and the tools. When some attempts from the first call passed, the report says so: an answer the model gets right only sometimes may still be what lost the run, and a lower bar (`--gate '{"good":0.3,"bad":0.05}'`) finds where.

Two findings say outright that no answer of the model's lost the run. When every attempt from the first model call makes the write that failed in the recording again and meets its error, the report names the tool and the error. And when probes do rescue the run, yet every attempt that passed answered the call the search ended on as the recording did, the answer is not what lost it: something after it made the difference, such as a read that ran live or a write that was stubbed. Blame then blames no call and says why.

`--set key=value` changes any other request field from the probed call on, like `--set` on [`replay`](./interventions.md#patch-parameters), where the provider keeps it.

## Blaming one part of the agent

An agent is often more than one model: a planner and an executor, or, in a benchmark, the agent and a model playing its customer. `--scope agent` probes only the model calls made in that [scope](./sdk.md#scopes), or in one nested in it, so the call blamed is always the agent's. A customer's answer that led nowhere is part of the run the agent had to handle, not something to fix. The report counts steps among the scope's calls only, and blame says which scopes a run has when the one given isn't among them.

## Side effects

Blame never lets a probe act on the world. After the fork, `write` tools are stubbed (`--writes stub`, the default): the agent receives the tool's `onFork` value and carries on as if the write had succeeded, which is closest to what happened in the recording. `--writes block` makes each write throw instead. That is safer for a tool with no `onFork`, but an agent that stops on the error fails the probe for a reason the recording never had. `--writes allow` is not accepted.

A write the recording made, the same tool with the same arguments, gets what it got then instead, an error included. Nothing runs either way, and a stub never fails: a run that failed because a write did, a digest posted to a channel that doesn't exist, would otherwise pass every probe whatever the model answered. A write that failed when it was recorded and was stubbed in the fork that rescued the run, because the model called it with other arguments, is named in a warning: whether it would have failed again is not known.

`read` tools run live after the fork, as in a replay; `--reads replay` serves them from the recording when their arguments match.

## Reading the report

| Line | Meaning |
|---|---|
| **The run was lost at model call #n (k of m)** | The last model call whose resampling rescued the run, the next one was found lost, and the check found rescue drops from one to the other: the boundary is pinned. *k of m* is its position among the run's model calls |
| **The run was lost gradually, around model calls #n and #n′** | The probes pinned #n, but the check found no drop from it to the next beyond chance: rescue falls gradually there, and no one call lost the run. Look at how the conversation drifts up to them, not at one answer |
| **The run was lost between model calls #n and #n′** | The last call that rescued the run, and the call before the first found lost after it: the probes between them were inconclusive, so the run may have been lost at any of these calls. The report names them |
| **The re-asked call #n: rescued · k of m · rate >= …; #n′, the next model call: lost · 0 of 4 · rate <= …** | The evidence on both sides of the boundary: each probe's verdict, its tally and the bound of its pass rate, under the gate's rule, stated over the probes. Under a fixed count (`--attempts`, `--passes`): *Resampling #n rescued k of m attempts; resampling #n′ … rescued …* |
| **Checked with N fresh pairs: #n rescued …, #n′ …** | The check of a pinned call: its pairs, what each call passed, and what they show: *rescue drops at #n beyond chance*; *rescue falls by less than 50 points from one to the next*; or *not enough to tell*, which leaves the two calls as the range too |
| **Not rescued from any model call** | Even resampled from the first model call, the gate found the run lost there: rescued less than 60% of the time from it, and so from any call, wrong at most the gate's risk. *Not rescued from the first model call* says the same under a rule that can be wrong more often (a fixed count) |
| **Not settled from the first model call** | Resampled from the first model call, the run passed some attempts and failed others, and the gate could not tell a rescue from a loss within its attempts: *inconclusive*, with its tally and bound; or an attempt there could not be judged, with the check and why. Confidence is low, and the report says how to settle it: more attempts (`max`) or a lower bar (`good`) with `--gate`, or what decides the check. The run keeps it so: `shadowlap show`, its page, Needs a look, Fixes and a repair that reuses the blame say *not settled*, never *not rescued* |
| **Confidence** | Read from the error bound it states, the sum of the risks of the probes that decided (`<= 2.9% risk that the call is wrong: 3 probes decided, at <= 0.8% risk each, and the check of #5, at <= 0.6%`). *high*: within the gate's risk, 5%. *medium*: within twice that or 20%, as a fixed count's few probes are (2 of 5 can be wrong 8.8% of the time a probe). *low*: beyond, or nothing bounds it: the search stopped early, the first probe was inconclusive, or rescue rose again past a call found lost by more than chance explains |
| **At #n** | What the model answered at the blamed call in the recording, and in a fork that went on to pass. This is the contrast to act on: the bad path and a good one, from the same point |
| **Probes** | Under the gate's rule, every call probed: how many attempts passed with the bound of its pass rate at the probe's own confidence, and the verdict, rescued, lost or inconclusive. Under them, any probes the non-increasing fit read as one rate because rescue rose as the calls went on (`#7, #9 read as one rate, 0.40: rescue rose after it fell`) |

Once you have a fix, [`shadowlap verify`](./verify.md) checks it on the blamed run, on failures it was not written against, and on runs that worked. [`shadowlap repair`](./repair.md) does both steps for a fix to the prompt: it asks a model for rewrites and keeps the one the gate accepts.

Every attempt is a run in the store, marked as a blame attempt and bundled per probe in the dashboard's forks view, the way `--repeat` attempts are. `shadowlap show` prints what blame found on the blamed run and on each attempt. The rescued fork is an ordinary run: `shadowlap diff <run> <fork>` compares it with the recording, and `shadowlap ui <fork> --call <n>` opens it at the blamed call.

## Fixes

Every blame is kept in the store whole, with the fix it opens or joins. A fix is one failure, from the blame that reproduced it to a change that held: [`shadowlap fix`](./cli.md#fix) lists them and shows each one's blame, repair and verify. The report ends with it:

```
  fix fx-01M3RZ4XKN · issue_refund called with amount 240 · opened · shadowlap fix show fx-01M3RZ4XKN
```

Which fix a blamed run goes to. Labels come first, because they are how you group runs, and the check decides where they can't. The check is the `--expect` the blame was given, whatever order its keys are in; without `--expect`, it is the exit code. A fix's labels are the ones its failing runs carry now, so a label given to its runs later counts, and the label `good` never names a failure.

- A run that already fails in a fix stays in it, so blaming it again, with `--model` say, adds a blame to the same fix. That holds for an applied fix too: an old recording can't show the failure coming back.
- Otherwise it joins a fix that shares one of its [labels](./cli.md#label-note) and has the same check.
- Else a fix that holds every label the run has, whatever its check: the label decides. A run labelled `refund-over-limit` and blamed under another check joins the `refund-over-limit` fix.
- Else a fix with no labels and the same check. A run with no labels joins the fix with its check, labelled or not, when only one fix has it.
- Otherwise the blame opens a new fix. Its title says how the recording failed the check, in plain words: *issue_refund called with amount 240*, *send_email called twice, not once*, *Output never says "refund issued"*. `shadowlap fix title` replaces it with one of your own.

A run that shares one label with a fix but carries another the fix doesn't hold, under another check, is taken for another failure: a run labelled `customer-x` and `double-email` opens a fix of its own next to a `customer-x`, `refund-over-limit` fix, rather than hide in it. Where several fixes would take a run, the one sharing more of its labels wins, then the first opened. Runs labelled differently stay apart even under the same check.

A blame that stopped early opens or joins a fix too: it replayed the run and saw it fail before it probed anything, so the failure is reproduced. A blame that refused (the run passes, or doesn't replay as recorded) leaves nothing behind. An applied fix is finished: no new run joins it, and the same failure in a run recorded after it shipped opens a new fix.

Each blame also logs a `blame.done` event in the store's activity. Run by a dashboard job, it reports a link to the fix's Blame step.

## Cost

Each probe replays everything before its call for free. The calls after it run live, so later probes are cheaper. A search makes at most `1 + ⌈log₂ m⌉ + scan` probes for *m* model calls, each of at most the gate's `max` attempts deepened to its share of the risk (31 to 36 at the defaults, or `--attempts` with a fixed count), and usually far fewer attempts than that, because a probe stops once its verdict is settled; a call they pin is checked with up to twice a probe's attempts in pairs. The header prints the bound before anything runs. Spending the risk across the probes asks each for more evidence than a probe at the full 5% needed, three passes to rescue where two did, six or seven failures to lose where four did, and the check of a pinned call takes a dozen pairs or more: in the engine's simulation a search of 30 calls takes 47 to 147 attempts on average where, at the full 5% a probe and unchecked, it took 15 to 56, about three times as many, for a location whose error is bounded and a call named only when rescue drops there.

| Option | Effect |
|---|---|
| `--budget <usd>` | Start no attempt once this much is spent on live model calls. Attempts already running finish, so the total can pass the budget by one attempt per concurrent slot. Needs prices for the models involved: an unpriced model counts as $0, and the report names it |
| `--timeout <seconds>` | Stop an attempt after this long and count it as failed, for an agent that can loop |
| `--concurrency <n>` | Run up to *n* attempts of a probe at once, and at most *n* − 1 past the one that decides it. Probes still run one after another, since each depends on the last |

Stopping early still prints what the search found so far, and exits 3 when the budget or a provider that stayed unavailable stopped it, 130 for Ctrl-C. A search *not settled from the first model call* exits 3 as well: it reached no verdict. Attempts the provider was unavailable for are paid for and counted apart, never as attempts: *0 attempts (and 3 the provider was unavailable for, not counted)*; one it cut short after the model answered is an attempt, counted against either verdict.

## JSON

`--json` prints the report on stdout (progress still goes to stderr), for scripts and [coding agents](./agents.md):

| Field | |
|---|---|
| `runId` | The run blamed |
| `outcome` | `blamed`, `unrescuable` or `stopped`; `error` when blame refused, with `error.reason` (`passes`, `unpriced`, `inconclusive`, `diverged`, `bypassed`, `prefix`, `no-model-calls`, `interrupted`), `error.message`, and `judge` for what [judge checks](./judges.md) spent before it refused |
| `blamed`, `lost` | `{ callNo, step, passes, attempts }` for the blamed call and the one after it, or `null` |
| `range` | `{ from, to }`: the calls the run was lost between, by call number, from the last that rescued it to the one before the first found lost after it; `from` and `to` the same when the boundary is pinned; with `gradual: true`, the call the probes pinned and the next, when its check found no drop there; `null` when no call rescued the run |
| `pin` | The check of the call the probes pinned, or `null` when they pinned none: `callNo` and `next`, its `verdict` (`pinned`, `gradual` or `inconclusive`), the `pairs` it ran, the `passes` at the call and `nextPasses` at the next, the pairs that passed at the call and failed at the next (`dropped`) and the other way round (`rose`), its `rule` (`margin`, the drop it tells from none; `risk`, a probe's share; `max` pairs), `risk` (the most its verdict can be wrong, exactly; 0 when it claimed nothing), `undecided` (why an attempt could not be judged, when one stopped it), `cutShort`, and `runs`, each pair's attempts as `{ at, next }` |
| `errorBound` | The most the range, or the finding that no call rescues the run, is wrong, from 0 to 1: the sum of the risks of the probes that decided, and of the check's when it found a drop or none; `null` when nothing bounds it (the search stopped, the first probe couldn't tell, rescue rose again beyond chance) |
| `confidence` | `high`, `medium` or `low`, read from `errorBound`: within the gate's risk, within twice it or 20%, beyond or unbounded |
| `fit` | Each probe's rescue rate fitted non-increasing (isotonic regression), in call order: `{ callNo, rate }`, `rate` `null` for a probe with no attempt judged |
| `contrast` | `{ callNo, recorded, rescued, rescuedRunId }`: the model's answer at the blamed call in the recording and in the rescued fork, as blocks (`text`, `thinking`, `tool_call` with `name` and `input`) |
| `sameAnswer` | `{ callNo, runId, why }` when probes rescued the run but every attempt that passed answered the call the search ended on as the recording did, so `outcome` is `unrescuable`: that call, an attempt that passed, and why it passed. Otherwise `null` |
| `failedWrite` | `{ name, message, callNo }` when no probe rescued the run and every attempt from the first model call (`callNo`) met the error a write got when the run was recorded: the tool and the error. Otherwise `null` |
| `probes` | Per probe: `callNo`, `step`, `passes`, `attempts`, `rescued`, `risk` (the most its claim can be wrong, exactly, at the gate's two rates), `unavailable` (its attempts the provider was unavailable for before the model answered, retried and never counted), `cutShort` (those it cut short after, counted against either verdict, each with `cutShort: true` among `runs`), the gate's `decision` (`pass`, `fail` or `inconclusive`; `null` under a fixed count, unless an attempt could not be judged, which makes it `inconclusive`), its `rate` (the `decision`, the `interval` of the pass rate, exact under the gate's stopping, and the `sentence`, as the report words it: `rescued · 5 of 10 · rate >= 0.10 (99%) · gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 31 attempts`; `null` under a fixed count, or when an attempt that could not be judged stopped it), `undecided` (why that attempt could not be judged; `null` otherwise), and `runs`, each with `runId`, `passed`, its `verdict` (`passed`, `failed`, or `inconclusive` when all it fell short on is a check that could not be decided), `exitCode`, `failures`, `spent`, `upstreamRequests` and `unrecordedTools`, the tools its model called that its run never recorded, which ran for real in it, as [`show --json`](./cli.md#show) lists them |
| `oracle`, `recordedFailures` | What a passing run must do, and how the recording fails it |
| `rescue` | `{ fields }`: the request fields a probe changed; empty when it resampled |
| `gate` | The search's gate, `{ kind, good, bad, risk, max }`, its risk the whole search's, or `null` when a fixed count (`--attempts`, `--passes`) decided |
| `probeBudget`, `probeGate` | The most probes the search's risk was split across, and the gate each probe ran under at its share, `max` deepened to it; `null` under a fixed count |
| `modelCalls`, `attemptsPerProbe`, `passesNeeded`, `nonMonotone`, `cost`, `stopReason` | The search's parameters and what it spent: `modelCalls` counts the agent's model calls, never a judge check's; with a gate, `attemptsPerProbe` is its `max` and `passesNeeded` the fewest passes that can rescue (2); `cost.unavailable`, the attempts the provider was unavailable for, retried and never counted in `cost.attempts`; `stopReason` why it stopped, `provider unavailable: …` for a provider that stayed unavailable |
| `judge` | `{ spent, upstreamRequests }`: what [judge checks](./judges.md)' calls cost, apart from `cost`, which is the agent's alone; `null` when no judge was asked live. `--budget` counts both |
| `warnings` | What the replays warned about, such as a connection that bypassed Shadowlap |
| `fix` | `{ fixId, title, status, opened }`: the [fix](#fixes) the blame opened (`opened: true`) or joined, or `null` when the store could not keep it |

## When blame refuses

| Message | Why | What to do |
|---|---|---|
| *passes its oracle when replayed* | The replayed run does what the oracle asks, so there is no failure | Say what it should have done with `--expect` |
| *fails only because … has no price* | The only check it fails is a cost check, which can't be judged for a model with no price, whatever the model answers | Add the model under `prices` in `shadowlap.config.json`, and blame again if it still fails |
| *--expect has a check no attempt can decide* | A [judge check](./judges.md) whose judge can't be asked live (no key for its provider, and no upstream set for it): each probe is a fork, which asks the judge live, so every attempt would read inconclusive and none could pass. Refused before anything runs | Give the judge its provider's key, or leave it out of `--expect`; [`shadowlap check`](./checks.md#try-a-check-on-your-recordings) judges recordings by the verdicts they hold |
| *has a check that can't be decided as recorded* | A check is [inconclusive](./checks.md#how-a-check-comes-out) on the free replay (a judge with no verdict, a `when` whose condition reads a value the run doesn't have), so it would be on every probe too | Fix the check, such as the path a condition reads (`shadowlap doctor` names one no recorded call has), or leave it out of `--expect` |
| *does not replay as recorded* | The replay forks by itself, so a probe could not tell a changed answer from a changed prefix | [`shadowlap calibrate`](./normalizers-and-redaction.md#calibrate), then blame again |
| *forked at call n instead* | An attempt ran a prefix the recording doesn't hold | As above. Branches that run at once need [scopes](./sdk.md#scopes) |
| *made no model calls* | There is no model answer to blame, or none in the `--scope` given | Check the scope names blame lists |
| *did not replay through Shadowlap* | The recording has model calls and the replay made none: the agent reached its model some other way, often a local server Shadowlap was told about when recording (`SHADOWLAP_UPSTREAM_OPENAI`) and not now | Replay in the environment you recorded in |

## Limits

- Blame points at a model call, because a model answer is the one thing a probe can ask for again. A failure caused by a tool returning bad data shows up as *not rescued*, or as blame on a call that read the bad data; an [override](./interventions.md#override-a-tool-result) tests that directly.
- A write that failed, such as a post to a channel that doesn't exist, shows up as *not rescued* with the write and its error when every attempt makes it again, since a write a probe repeats gets its recorded error. One a probe makes with other arguments is stubbed, so a rescue that went through it comes with a warning.
- The verdict is statistical, and says what its gate tells apart: a call that passes 60% of the time or more from one that passes 10% or less, with the gate's risk spent across the probes. It never claims a rate: a call the model gets right 30% of the time is between the two, and at a search's usual share of the risk is rescued 35% of the time, lost 47%, and left inconclusive 18%. Its tally and bound say what the attempts show. A run rescued 45% of the time from its first calls, then never, is reported not rescued at 60%+ from any call, with high confidence, about 7% of the time: true at the gate's bar, and the first probe's tally shows the passes. For an agent that rarely succeeds, lower the bar, as in `--gate '{"good":0.3,"bad":0.05}'`, which takes more attempts. [Gating](./gating.md) has the maths.
- The bound rests on rescue falling as the calls go on. A rise the probes show beyond chance voids it; one they never probed, a dip further along, goes unseen: the binary search finds *a* boundary.

