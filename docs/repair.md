# Repair

`shadowlap repair` fixes failing runs, and hands the fix over with the evidence that it holds. It finds where each run was lost with [blame](./blame.md), asks a model you choose to rewrite the agent's instructions, and keeps the smallest rewrite that the [verify](./verify.md) gate accepts: the failing runs fixed, runs it never saw fixed too, and the good runs still passing.

```sh
shadowlap repair --fixes label:refund-bug --keeps label:good \
  --expect '{"tools":{"issue_refund":{"count":0,"args":{"amount":240}}}}' --repairer anthropic
```

```
✓ Fixed: Escalate refunds above the policy limit
  agent.mjs · system prompt
  - You are a support agent. Follow the refund policy.
  + You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.

  Verified: fixes 1 of 1 target run, 1 of 1 held-out, keeps 1 of 1 good, each at 4 of 5 attempts

  Where the failing runs were lost
    01M3RZ4XKN  model call #5 (3 of 4)

  Diagnosis (claude-opus-5-5)
    The system prompt says to follow the policy but not what the policy asks of large refunds, so the model reaches for the refund tool it was asked about.

  Candidates (tried smallest first; the first the gate accepts is kept)
     1  invalid   system prompt: You are a support agent. Follow the refund policy, and never ref…
        it mentions A-1042, which only the failing runs contain: a fix has to hold for cases it has not seen
     2  rejected  tool issue_refund: Refund an order. Check the policy first.
        target run 01M3RZ4XKN not fixed: 1 of 3 passed (issue_refund with {"amount":240} called 0 times, but called 1 time (1 blocked or stubbed))
     3  accepted  system prompt: You are a support agent. Follow the refund policy: escalate ever…

  cost: blame ≈$0.041 · repairer ≈$0.0040 · verify ≈$0.082
  patch: .shadowlap/repairs/repair-munzln2i/fix.patch   apply it: git apply .shadowlap/repairs/repair-munzln2i/fix.patch
  report: .shadowlap/repairs/repair-munzln2i/report.md
  recordings of the fixed runs, for shadowlap test: .shadowlap/repairs/repair-munzln2i/goldens/01M3RZ4XKN .shadowlap/repairs/repair-munzln2i/goldens/01M3RZ4XTE
```

Of the three rewrites the repairer proposed, the first named the order that failed and was set aside before anything ran. The second changed nothing the model acted on, and the gate rejected it. The third was accepted. Your working tree is as it was; the fix is a patch, a report written for a pull request, and a recording of each fixed run.

## Only proposing is left to a model

The repairer is asked for candidates, and that is all it does. Everything that decides what is kept is deterministic: where the run was lost, whether an edit may be applied, the replays, and the verdict. A model that grades its own fixes is lenient with them; here it never sees the verdict until the gate has given it.

| Step | Who | What |
|---|---|---|
| Localize | `shadowlap blame` | For each failing run, the model call where it was lost, and a fork from that call that passed |
| Propose | the repairer | Rewrites of the system prompt or a tool description, each with a different strategy |
| Screen | Shadowlap | Sets aside any rewrite that can't be applied safely or that names a detail of the failing runs |
| Verify | `shadowlap verify` | Tries each remaining rewrite, smallest first, and keeps the first the gate accepts |
| Hand over | Shadowlap | A patch and a report; on request the fix applied, a branch, a pull request |

**The repairer sees the contrast, not just the failure.** Blame yields two versions of the same step: what the agent did in the failed run, and what it did from the same point in a run that passed. The repairer gets the conversation up to that call, both answers, and the check that failed. That tells it much more than "here is a failure, fix it".

**Fixes that need no model come first.** If asking the recorded model again rescues nothing, but `--stronger <model>` does, the first candidate is to switch to that model: its name, found once as a string in the source, replaced. The repairer is only asked when that isn't enough, or doesn't apply.

## What a fix may change

A rewrite replaces one **anchor**: a span of the system prompt or of a tool description, as the recording shows it, that appears verbatim exactly once in the project's files (tracked, or untracked and not ignored). That makes every candidate applicable where the text lives, and every patch one readable change. A prompt assembled from pieces still anchors: each sentence or line that appears once is its own span. When nothing anchors, the report says so, and the fix is for a person or a coding agent to make.

A rewrite of a one-line span stays on one line. A span in code sits in a string, so its rewrite may not bring in quotes or backslashes; a span in a Markdown or text file, such as a policy the agent is given, is prose, and may.

## Guarding against fixes that fit the examples

A model shown two failed refunds will happily write "never refund order A-1042". Three things stop that from shipping:

- **Case details are forbidden.** Ids, amounts and email addresses that appear in the failing runs, but not in the good runs or in the agent's own prompt, may not appear in a replacement. The repairer is told so, and a candidate that names one is set aside before anything runs. A number the policy itself uses, such as its $100 limit, is fine: it appears in the good runs too.
- **Held-out runs decide.** Failing runs given with `--holdout` are never shown to the repairer, and the gate must fix them too. Without `--holdout`, and with two or more failing runs, every other one is held out automatically. A fix that only fits the runs it was written against fails here.
- **Prompts don't grow for free.** A fix that grows the input tokens per run by more than `--max-growth` (25% by default) is rejected, however well it scores.

## Candidates are tried in your working tree

Each candidate is applied in place, verified, and put back. The agent's command, its dependencies and its build output are already there. A copy elsewhere would run a recorded absolute path against the original code, or fail to start without the untracked `node_modules` or virtual environment. `--build "npm run build"` rebuilds after each change and after each restore.

Before an edit, the original bytes go to `.shadowlap/repair-journal.json`. The file is restored after each candidate, on Ctrl-C, and at the start of the next repair if a process died; `shadowlap doctor` reports a journal left behind. A file you edit while a candidate is being verified is left alone, and the report says so.

## Handing it over

| Option | What you get |
|---|---|
| (always) | `.shadowlap/repairs/<id>/`: `fix.patch`, `report.md` (a pull request body: the change, where each run was lost, the evidence, every candidate and why it was dropped), `report.json`, and `goldens/`, a recording of each fixed run |
| `--apply` | The fix left in the working tree |
| `--branch <name>` | A commit with the fix on a new branch, the evidence in its message. Nothing is checked out: HEAD and the working tree stay as they are |
| `--pr` | With `--branch`: the branch pushed to `origin` and a pull request opened with `gh`, the report as its body |
| `--goldens <dir>` | With `--apply` or `--branch`: the recordings also placed in the project, for [`shadowlap test`](./ci.md). The folder is taken from the one repair runs in; with `--branch` it has to be inside the repository, which repair checks before it starts |

The recordings were made by the fixed code, so `shadowlap test` replays them clean with the fix in place and fails the build if it is ever undone. Together with the patch, they turn a bug into a regression test.

## The repairer

Any model from any vendor, configured rather than built in:

```json
{ "repair": { "repairer": "anthropic:claude-opus-5-5" } }
```

| Value | |
|---|---|
| `anthropic` | Claude Opus 5.5, through the Anthropic SDK, with `ANTHROPIC_API_KEY` or an `ant auth login` profile. The SDK is an optional peer of Shadowlap, so it isn't installed for everyone: `npm install @anthropic-ai/sdk` next to `shadowlap` |
| `anthropic:<model>` | Another Claude model, such as `claude-fable-5-1` |
| `openai:<model>` | Any Chat Completions API: OpenAI, OpenRouter, a local server such as Ollama or vLLM (`OPENAI_BASE_URL`, `OPENAI_API_KEY`) |
| `claude-code`, `claude-code:<model>` | Your own [Claude Code](https://code.claude.com), run in print mode (`claude -p`), with no tools, the answer held to a JSON schema. It runs as whatever Claude Code is signed in with; Shadowlap never sees its credentials. Without a model, Claude Code's own default is used. `SHADOWLAP_CLAUDE` names the binary when `claude` isn't on the PATH |

`--repairer` overrides the config, and `repair.baseUrl` points it at a gateway. Claude is asked with high effort and structured output. On models that support it, the API's server-side fallback answers a policy decline from another model in the same call, and the report names the model that answered. It is called once per repair, so even the most capable model costs little next to the replays.

Claude Code runs in an empty temporary directory, so no project's `CLAUDE.md` reaches the prompt. It runs without the variables of any Claude Code session it was started from, so a repair started inside Claude Code asks a fresh one. Its system prompt is a file (`--system-prompt-file`) and the request goes on stdin, so the command line carries no line break, and on Windows a `claude` npm installed, a batch file, runs through cmd.exe. The cost reported is Claude Code's own estimate.

Without a repairer, repair still tries the fixes that need none (`--stronger`), and says it skipped the rest.

## The fix it reports to

Repair blames each failing run first, and each blame opens or joins a [fix](./blame.md#fixes), so a repair of runs never blamed opens one. The repair is kept with that fix: its report, its directory, and every candidate it tried with why it was dropped. When its `--expect` covers the fix's check, its failing runs, held-out ones included, become the fix's failing runs, and its good runs the fix's good runs.

- When a candidate is accepted, its verification is kept as a verdict of its own. It turns the fix verified when it [counts](./verify.md#verdicts-are-kept) for it: checked under the fix's check, or one that asks for more. With `--apply` the change is already in the working tree, so the fix is applied; it copies no goldens into the project unless `--goldens` says where, and runs no test, which [`shadowlap fix apply`](./cli.md#fix) does later. With `--pr`, the pull request becomes where the fix came from.
- When none is accepted, repair exits 1 and the fix stays open, and `shadowlap fix show` lists each candidate it tried, rejected or set aside, with why.
- When handing the fix over fails part way (a push or `gh pr create` refused, a file changed during the repair, the recordings could not be copied to `--goldens`), repair says why and exits 1, and keeps the repair anyway: `report.json` is written, the fix turns verified, or applied when the change was applied before the failure, and the report's warnings say where the hand-over stopped. Goldens that didn't reach the project are left for `shadowlap fix apply` to copy.

[`shadowlap fix apply <fix>`](./cli.md#fix) hands a verified fix over later: it applies `fix.patch`, copies the recordings in `goldens/` into the project's goldens folder, runs `shadowlap test` on them, and marks the fix applied. A repair logs `repair.accepted` or `repair.empty` in the store's activity, and `fix.applied` for a fix `--apply` applied. Run by a dashboard job, it reports a link to the fix's Repair step.

## Outcomes

| Outcome | Exit | Meaning |
|---|---|---|
| **Fixed** | 0 | A candidate passed the gate. 1 when the hand-over asked for (`--apply`, `--branch`, `--pr`) failed part way |
| **Not fixed** | 1 | No candidate passed; the report lists each and why |
| **No fix to try** | 1 | No failing run was rescued, so there is no passing path to learn from. With `--stronger`, not even a stronger model rescued them: look at the code and the tools |
| **Stopped** | 1 | Ctrl-C or `--budget`; what was found so far is reported |

`--json` prints the whole report, each candidate with its verification, for scripts and [coding agents](./agents.md). It adds `repairId` (the directory name the repair is kept under), `verifyId` (the verdict kept for the accepted candidate, or `null`), `fixes`, each fix it reported to with `fixId`, `title`, `status`, whether the verdict `counts` for it (`null` without a verdict) and `why` not, and `error` when the hand-over failed.

## Options

| Option | Effect |
|---|---|
| `--fixes <run...>` | The failing runs to repair: ids, prefixes or `label:<name>` |
| `--holdout <run...>` | Failing runs kept from the repairer (default: every other `--fixes` run, when there are two or more) |
| `--keeps <run...>` | Runs that pass and must keep passing, such as `label:good` |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0 ([outcome checks](./ci.md#outcome-checks)) |
| `--repairer <provider:model>` | The model that proposes fixes (default: `repair.repairer` in the config) |
| `--candidates <n>` | Rewrites to ask for. Default 3 |
| `--stronger <model>` | Rescue with this model when the recorded one can't be, and try switching to it |
| `--scope <name>` | Blame only the model calls of this scope: the agent's, not a simulated user's |
| `--set <key=value>` | Blame's probes set this request field, such as `temperature=1` for an agent recorded at 0, whose answers don't vary when asked again |
| `--attempts <n>`, `--passes <n>` | The gate: a run passes at 4 of 5 attempts by default |
| `--max-growth <percent>` | Reject a fix that grows input tokens per run by more than this. Default 25 |
| `--build <command>` | Rebuild the agent after its source changes |
| `--apply`, `--branch <name>`, `--pr`, `--goldens <dir>` | Hand-over, above |
| `--budget <usd>` | Stop once this much is spent on blame, the repairer and verification |
| `--writes`, `--reads`, `--concurrency`, `--timeout`, `--guard`, `-y`, `--json` | As for [verify](./verify.md) |

## Limits

- A fix is a rewrite of the prompt, a tool description, or the model's name. A cause in the harness (parsing, dispatch, state, stop conditions) needs a code change. Blame's report and the repair report are the brief for making it, by hand or with a coding agent, and `shadowlap verify` checks it for free, since a harness fix changes no request.
- Case details are recognised by their form: ids, amounts, addresses. A person's name in a replacement is not caught by the screen. The held-out runs still are.
- One rewrite per candidate. A problem that needs two coordinated edits needs two repairs, or a person.
