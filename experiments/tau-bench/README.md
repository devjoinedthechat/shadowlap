# Repairing tau2-bench failures

Does [`shadowlap repair`](../../docs/repair.md) fix an agent's failures on tasks it never saw, without breaking tasks that worked, and at what cost? This experiment answers that on [tau2-bench](https://github.com/sierra-research/tau2-bench), where an agent serves simulated customers under a written policy and every task is graded automatically.

The result is one line: *of the test failures, Shadowlap's repairs fixed X, broke Y of the test tasks that passed, and cost $Z*. It comes next to a control arm that shows how much re-running alone accounts for.

## The protocol

1. **Record.** Run each task of the chosen split once, under `shadowlap run`. The task's reward decides pass or fail: `run_task.py` exits 0 only on the full reward, and that exit code is the oracle for everything after.
2. **Blame.** Blame every failure, probing only the agent's model calls: the simulated customer's are in another scope and are never blamed. Probes resample the agent at temperature 1, because at the benchmark's temperature of 0 asking again gives the same answer. The setting applies from the probed call on to every model call, the customer's included, so a rescue's customer varies a little more than the benchmark's does.
3. **Group and split.** Failures are grouped by what the agent did at the call where the run was lost and what a passing run did from there, such as `cancel_pending_order → reply`. Every group, like the passing runs, is split between a **dev** half and a **test** half, alternating in task order. Nothing in the repair loop sees the test half.
4. **Repair, per repairer.** Each dev group goes to `shadowlap repair --apply`. It sees one half of the group's dev failures, the other half must be fixed too, and a sample of the dev passing runs must keep passing. Accepted fixes accumulate in that repairer's copy of the policy.
5. **Evaluate.** Under each repairer's final policy, `shadowlap verify` replays the test half: every test failure, fixed when 4 of 5 attempts pass, and every test passing run, broken when fewer do.
6. **Control.** The same evaluation under a placebo policy. It has a comment appended, so the agent reads the same rules and every run forks at the same call as under a real fix. Its row counts what re-running live fixes and breaks on its own; a repair is only worth the difference.

Two repairers from different vendors, each in its own arm, show that the result is not one model's.

### What repair may change

The agent's system prompt is tau2's agent instruction followed by the domain policy. The project holds its own copy of the policy (`data/tau2/domains/<domain>/policy.md`, read through `TAU2_DATA_DIR`), so each line and sentence of it is an anchor repair can rewrite. The instruction header and the tool code live in the installed benchmark and stay as they are. The database, the tasks and the grading are never touched.

### Why these choices

- **tau2-bench, not tau-bench.** The original repository says its tasks are no longer updated, and tau2-bench is where the benchmark is maintained. It is pinned to one commit, so the tasks, the policy and the grading are the ones a result describes.
- **Scopes.** The simulated customer is itself a model. Without scopes, blame could conclude that the customer's message lost the run, and repair would try to rewrite the customer. `run_task.py` runs each side's turns in its own scope.
- **A placebo control, not a plain replay.** A plain replay of a failure reproduces it exactly, so it would make any repair look good. The placebo re-runs the same failures live, at the same point, so luck is counted on both sides.
- **Groups split, not runs.** Splitting within each group checks whether a fix holds for other instances of the failure it was written for. Splitting whole groups would ask it to fix failures of a different kind.

## Running it

You need Node ≥ 22.16, git, [uv](https://docs.astral.sh/uv/), this repository built (`npm install && npm run build`), and keys for the models you choose. Setup pins Python 3.12, which tau2-bench's text mode still needs (it imports `audioop`).

```sh
node experiments/tau-bench/experiment.mjs setup

node experiments/tau-bench/experiment.mjs all \
  --agent-llm openai/gpt-5-mini --user-llm openai/gpt-4.1-2025-04-14 \
  --repairer anthropic:claude-opus-5-5 --repairer openai:<model> \
  --max-cost 150
```

`all` runs the steps below in order; each can also be run on its own, and each picks up where it stopped. Everything goes into `experiments/tau-bench/workspace/`, which git ignores:

| Step | What it does |
|---|---|
| `setup` | Clones tau2-bench at the pinned commit, builds its environment from its lockfile, installs Shadowlap's Python SDK into it, and makes the agent project: a git repository with the policy, the tasks and `run_task.py` |
| `record` | Runs each task once, labels it `tau:pass` or `tau:fail` |
| `blame` | Blames each failure, groups them, and fixes the dev/test split in `state.json` |
| `repair` | Repairs each dev group, per `--repairer`, on a branch `arm/<repairer>` of the project; the policy diff is saved as `results/<arm>.patch` |
| `evaluate` | Verifies the test half under each arm, and under the placebo |
| `report` | Writes `results/results.md` and `results/results.json` |

| Option | Default | |
|---|---|---|
| `--domain` | `retail` | `retail` or `airline` |
| `--split` | `test` | `test`, `train` or `base` |
| `--tasks` | `all` | `first:10`, or ids such as `5,7,12` |
| `--agent-llm`, `--user-llm` | | litellm model names. The agent should be a cheap model: more failures to repair |
| `--api-base` | | an OpenAI-compatible server for both, such as Ollama at `http://127.0.0.1:11434/v1` ([see below](#local-models)) |
| `--repairer` | | once per arm: `anthropic`, `anthropic:<model>`, `openai:<model>`, or `claude-code[:<model>]` for your own Claude Code |
| `--attempts`, `--passes` | 5, 4 | the verify gate, in repair and in evaluation |
| `--blame-attempts`, `--blame-passes` | 5, 2 | blame's probes |
| `--rescue-temperature` | 1 | the temperature blame resamples the agent at |
| `--good-sample` | 6 | dev passing runs each repair must keep passing |
| `--candidates` | 3 | fixes to ask each repairer for, per group |
| `--seed`, `--max-steps` | 300, 60 | per task |
| `--max-tokens` | 4096 | per model call: a thinking model left unbounded can loop until the run is killed |
| `--budget` | | USD for each Shadowlap command |
| `--max-cost` | | USD for the whole experiment: no command starts past it |

### Local models

Ollama cuts a prompt longer than its context window and returns an answer anyway. Its default window is 4096 tokens, split between its parallel slots, and tau2's agent prompt starts near 6,000. So a model served with the defaults sees the tail of its conversation without the policy or the tools, and fails every task in a way that looks exactly like a weak model. Start the server with a window that holds the whole prompt:

```sh
OLLAMA_CONTEXT_LENGTH=32768 OLLAMA_NUM_PARALLEL=2 ollama serve
```

Two slots of 16,384 tokens each let the agent's prompt and the customer's stay cached side by side, which makes every call after the first much faster. `record` checks before it starts: each model gets a prompt of about 12,000 tokens, and the server must count all of it, or nothing is recorded.

### What it costs

Every replay serves the calls before its fork from the recording, so only what runs after a fork is paid for. Blame's probes run a suffix of a run. Repair and evaluation change the policy, which the agent reads at its first call, so their attempts run whole runs, and they are the expensive part. As counts of runs:

- **record**: one run per task;
- **blame**: at most `1 + ⌈log₂ m⌉ + 2` probes per failure (*m* agent calls), of up to `--blame-attempts` suffixes each, and usually far fewer, since a probe stops once settled;
- **repair**: per group and candidate, up to `--attempts` runs of each dev failure and each passing run sampled; the smallest candidates go first, the rest aren't tried after one is accepted, and a gate stops at the first run that fails;
- **evaluate**: up to `--attempts` runs of every test run, per arm, plus the control.

Record first (`record --tasks first:5`), read the cost per run in `state.json`, and set `--max-cost` from it. `--max-cost` stops the experiment before the command that would pass it; nothing done so far is lost, and running the same command again with a higher cap continues.

## Results

Not yet run with hosted models.

The whole pipeline has been run on the real benchmark with a local model: Qwen 2.5 7B through Ollama as the agent, the customer and the repairer, on the first two retail test tasks. That run checks the harness, not the method. What it showed:

- A recorded task replays clean: 31 of 31 calls from the recording, no upstream requests, in 1.9 s against 2 min 48 s live. Every call is tagged with the agent's or the customer's scope, and blame counted only the agent's 12 of a run's 19.
- The repair step skipped a group with nothing to learn from, and a repair aimed at it reused the stored blame and stopped in 0.1 s without a model call.
- The arm with no fix settled its test failure in one clean replay, at no cost. The placebo control forked at the agent's first call, as a real fix would, and ran it live.

Its failures, and blame finding nothing to rescue, say nothing about the model. The server ran with Ollama's default context window, and the model was shown the tail of each conversation without the policy or the tools, which is why `record` now checks the window before it starts. The same request that stalled Qwen 2.5 14B under that window, replayed whole from its recording, gets the right next step: the model reads the user id the tool returned and looks the user up.

Rewriting the policy on this benchmark has so far only been exercised against a scripted model, in Shadowlap's own tests. It needs an agent that sometimes passes, so that blame finds a run to learn from.

Published runs go in `results/`, one directory per run, with `results.md`, `results.json` and each arm's patch.
