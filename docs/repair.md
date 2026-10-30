# Repair

`shadowlap repair` fixes failing runs, and hands the fix over with the evidence that it holds. It finds where each run was lost with [blame](./blame.md), asks a model you choose to rewrite the agent's instructions, and keeps the smallest rewrite that the [verify](./verify.md) gate accepts twice: the failing runs fixed, runs it never saw fixed too, and the good runs no worse than before the rewrite.

```sh
shadowlap repair --fixes label:refund-bug --keeps label:good \
  --expect '{"tools":{"issue_refund":{"count":0,"args":{"amount":240}}}}' --repairer anthropic
```

```
✓ Fixed: Escalate refunds above the policy limit
  agent.mjs · system prompt
  - You are a support agent. Follow the refund policy.
  + You are a support agent. Follow the refund policy: escalate every refund above the limit.

  Verified: fixes 2 of 2 target runs, 1 of 1 held-out, keeps 1 of 1 good,
            each failing run by its gate, which tells 90%+ from 70%- at <= 5%
            risk, and each good one against its baseline, which tells no drop
            from one of 10+ points at <= 5% risk

  Where the failing runs were lost
    01M5FA9VJ6  model call #5 (3 of 5)
    01M5FA9W23  model call #5 (3 of 5)

  Diagnosis (claude-opus-5-5)
    The system prompt says to follow the policy but not what the policy asks of large refunds, so the model reaches for the refund tool it was asked about.

  Candidates (tried smallest first; the first the gate accepts twice is kept)
     1  invalid   system prompt: You are a support agent. Follow the refund policy. For order A-1…
        it mentions A-1042, which only the failing runs contain: a fix has to hold for cases it has not seen
     2  rejected  tool issue_refund: Refund an order in full. Check the policy first.
        target run 01M5FA9VJ6 not fixed: 0 of 3 passed · rate <= 0.71 (95%) (issue_refund with {"amount":240} called 0 times, but called 1 time (1 blocked or…
     3  accepted  system prompt: You are a support agent. Follow the refund policy: escalate ever…

  cost: blame ≈$0.107 · repairer ≈$0.0085 · verify ≈$0.238
  patch: .shadowlap/repairs/repair-mvi5coxh/fix.patch   apply it: git -c core.autocrlf=false apply .shadowlap/repairs/repair-mvi5coxh/fix.patch
  report: .shadowlap/repairs/repair-mvi5coxh/report.md
  recordings of the fixed runs, for shadowlap test: .shadowlap/repairs/repair-mvi5coxh/goldens/01M5FA9VJ6 .shadowlap/repairs/repair-mvi5coxh/goldens/01M5FA9W23 .shadowlap/repairs/repair-mvi5coxh/goldens/01M5FA9VTD
  fix fx-01M5FA9ZQR · issue_refund called with amount 240 · verified · shadowlap fix show fx-01M5FA9ZQR
```

A run blame found lost gradually, around two calls rather than at one, is listed so (*gradually, around model calls #17 and #18 (17 and 18 of 30)*), as the report written for a pull request, the commit and the repairer's prompt say it; the call the repairer is shown is the first of them. Of the three rewrites the repairer proposed, the first named the order that failed and was set aside before anything ran. The second changed nothing the model acted on, and the gate rejected it. The third was accepted. Your working tree is as it was; the fix is a patch, a report written for a pull request, and a recording of each fixed run.

## Only proposing is left to a model

The repairer is asked for candidates, and that is all it does. Everything that decides what is kept is deterministic: where the run was lost, whether an edit may be applied, the replays, and the verdict. A model that grades its own fixes is lenient with them; here it never sees the verdict until the gate has given it.

| Step | Who | What |
|---|---|---|
| Localize | `shadowlap blame` | For each failing run, the model call where it was lost, and a fork from that call that passed |
| Propose | the repairer | Rewrites of the system prompt or a tool description, each with a different strategy |
| Screen | Shadowlap | Sets aside any rewrite that can't be applied safely or that names a detail of the failing runs |
| Verify | `shadowlap verify` | Tries each remaining rewrite, smallest first, and keeps the first the gate accepts twice, the second time with fresh attempts |
| Hand over | Shadowlap | A patch and a report; on request the fix applied, a branch, a pull request |

**The repairer sees the contrast, not just the failure.** Blame yields two versions of the same step: what the agent did in the failed run, and what it did from the same point in a run that passed. The repairer gets the conversation up to that call, both answers, and the check that failed. That tells it much more than "here is a failure, fix it". What it is shown of a run goes through the project's [redaction rules](./normalizers-and-redaction.md#where-the-rules-apply) first, as every export, pack and share link of a run does; the screening for case details below reads the run as recorded, on your machine.

**Fixes that need no model come first.** If asking the recorded model again rescues nothing, but `--stronger <model>` does, the first candidate is to switch to that model: its name, found once as a string in the source, replaced. The repairer is only asked when that isn't enough, or doesn't apply.

**The fix kept passed the gate twice.** One verify accepts a candidate that falls short, one that leaves a failing run at 70% or below or breaks a good run, at most 5% of the time. But the first of several to pass is likelier than any one of them to have passed by chance: of four candidates that each leave a failing run at 70%, one passes 16.1% of the time. So the first the gate accepts is verified once more, with fresh attempts in a worktree of its own, and kept only if it passes again; one that doesn't is rejected, and the next is tried. Of those four, one is then kept 0.74% of the time. However many are tried, the chance a repair keeps one that falls short stays within the gate's risk: such a candidate passes both verifies at most risk² of the time (0.25% at 5%), and a repair decides at most 1/risk candidates (20 at 5%), leaving any more untried and saying so; a fixed count (`--attempts`, `--passes`) states no risk, so it has no such limit and no such bound. A good candidate pays for it with the attempts of a second verify, and a little power: one at 90% is kept 91.8% of the time rather than 95.8%. With `verify.baseline: history`, a good run's second verify compares it with the same test history as its first, so the two are not independent and risk² is no bound for it. In the engine's exact walk, a candidate that drops a good run by 10 points against a history of 50 attempts is kept by both at most 0.0184% of the time, up to 31 times what two independent verifies allow, and one of four such candidates at most 0.060%: still far within the 5%.

## What a fix may change

A rewrite replaces one **anchor**: a span of the system prompt or of a tool description, as the recording shows it, that appears exactly once in the project's files (tracked, or untracked and not ignored). No anchor is ever placed in a recording's files (a golden's `run.json`, which holds the command its replay runs, its calls and blobs, or anything in `__recordings__`), which hold copies of the prompts rather than their source, nor in `shadowlap.config.json`, the `.shadowlap` folder or git's own folder; a patch from the team store to any of them is refused. That makes every candidate applicable where the text lives, and every patch one readable change. A file reached through a link counts as the file it names, under that file's own path, when git lists that file too (it is tracked, or untracked and not ignored): a link to a shared prompt the repository tracks counts, while a link to a file git ignores, such as a `.env` or a build's output, or out of the repository, to another project's prompt or a file in your home folder, names nothing a repair reads or writes. Nor does a link into git's own folder: repair reads nothing in `.git`, nor in a git dir that a `.git` file names, which git lists as files it doesn't track when it is inside the repository. Its config can hold a credential, such as a remote's URL with a token or the header `actions/checkout` writes. A prompt assembled from pieces still anchors: each sentence or line that appears once is its own span. Repair reads no file over 1 MB, no binary file and no file with another name (a hard link), so a span only in one never anchors; and it places none in a file named `run.json` or `calls.jsonl` anywhere, or in a path Windows could read as another file's (a `:`, or a `~` and a digit). When nothing anchors, the report says so, and the fix is for a person or a coding agent to make.

A span the agent filled a value into anchors where the file has its placeholder. The recording holds `Refunds above 100 need a manager.`; the file holds ``f"Refunds above {limit} need a manager."``, or `` `Refunds above ${limit} need a manager.` ``, or `Refunds above {{ limit }} need a manager.` in a Jinja template, and that is the anchor, placeholder and all. Each line of a file with a placeholder is matched against the span, the placeholder standing for any text, and the span anchors when it is found that way exactly once and nowhere verbatim. Most of the span has to be the line's own words, and a placeholder holding more than a name (`${user.name ?? "customer"}`) is no place to stand, so a sentence that is mostly a value doesn't anchor.

A rewrite is held to text before anything runs. The repairer reads the failing runs, tool output included, and tool output can be anyone's words; verify then builds the agent's prompt from the rewrite, so a placeholder it brought in would be evaluated there, and its value sent to the provider and recorded. So a rewrite keeps exactly the placeholders of the text it replaces, each as it is written and as many times, and adds none, by what reads the file:

| File | Placeholders |
|---|---|
| JavaScript and TypeScript | a template literal's `${…}`; `{name}`, `{{ … }}`, `{% … %}` and `<% … %>`, which template libraries read; `%s` and Node's other format conversions |
| Python | an f-string's or `.format`'s `{…}`, and the `{{` and `}}` that escape a brace; `%s` and `%(name)s`; Jinja's `{{ … }}` and `{% … %}`; `string.Template`'s `$name` |
| Markdown and text | the same as Python, as a template engine or `.format` may render the file |
| Other code | all of the above, and Ruby's `#{…}` and the shell's `$(…)` |

A rewrite that drops one of them, or brings in another (`${process.env.GH_TOKEN}`, `{os.environ}`), is set aside, as is one with a brace of its own, or one that would make a placeholder with the characters on either side of its span: a `$` before it and a `{` it starts with. The repairer is told so.

A rewrite of a one-line span stays on one line. A span in code sits in a string, so its rewrite may not bring in quotes or backslashes; a span in a Markdown or text file, such as a policy the agent is given, is prose, and may.

## Guarding against fixes that fit the examples

A model shown two failed refunds will happily write "never refund order A-1042". Three things stop that from shipping:

- **Case details are forbidden.** Ids, amounts and email addresses that appear in the failing runs, but not in the good runs or in the agent's own prompt, may not appear in a replacement. The repairer is told so, and a candidate that names one is set aside before anything runs. A number the policy itself uses, such as its $100 limit, is fine: it appears in the good runs too.
- **Held-out runs decide.** Failing runs given with `--holdout` are never shown to the repairer, and the gate must fix them too. Without `--holdout`, and with two or more failing runs, every other one is held out automatically. A fix that only fits the runs it was written against fails here.
- **Prompts don't grow for free.** A fix that grows the input tokens per run by more than `--max-growth` (25% by default) is rejected, however well it scores. Its rewrite alone is measured first, before verify spends anything: each recorded request that carries the span grows by the characters the rewrite adds, counted at 5 characters a token, which is more than tokenizers fit into a token of English prose, so the estimate stays under what verify would measure. A rewrite already past the limit that way is rejected without a replay (*input tokens per run grow 31% from the rewrite alone, at 5 characters a token, more than --max-growth 25%, so it was not verified*); one that passes is measured again on the runs verify makes.

## Candidates are tried in a worktree of their own

Each candidate is verified in a temporary git worktree, in the system's temporary folder, never in your working tree: an editor's autosave, a dev server that reloads and a `shadowlap test` running beside the repair never see a candidate. It is checked out without the repository's hooks, and it is your working tree as it is, not HEAD: tracked files with uncommitted changes and untracked files git doesn't ignore are copied in, so verify replays the code you started the repair on, with one change. A link among them stays a link, except that one naming a path in the repository by its absolute name names the worktree's copy. What git ignores comes along as the agent needs it: `node_modules` is linked package by package (a package of the repository itself is the worktree's own copy, so a candidate in it is the one that runs), a Python virtual environment is linked, packages installed in a folder above the repository are linked in too, Python's caches (`__pycache__`, `.pytest_cache` and the like) are left out, and everything else, such as a `.env` or build output, is copied. What is copied of your files and of what git ignores comes to 256 MB at most; beyond that a file is linked, which the report says. The recorded command runs there as [bisect](./ci.md#find-the-commit-that-broke-it) runs it at a commit: an absolute path into the repository becomes the worktree's copy.

A candidate is written into the worktree's own copy of its file, never through a link: one whose file there is a link, or can't be written (a file you may only read, say), is *incomplete*, with why, and the next is tried. Repair walks each folder on the way, opens the file without following a link and without emptying it, and writes only once what it opened is the file the path, walked again, names: a folder swapped for a link while it opens the file, by a process racing it, is refused, and the file that link led to is left as it was; so is a file with another name (a hard link), the same file wherever that name is. That guards against a repository's links and against such a swap, not against a process of yours that rewrites the worktree while repair works in it: that process runs as you, and could write the files itself.

`--build "npm run build"` builds in the worktree, once the candidate is in it. A build writes into what it builds with, so with `--build` nothing it builds with is linked from your working tree: `node_modules` is copied whole, whatever its size and apart from the 256 MB (cloned where the file system can, as APFS, Btrfs and XFS can), a package of the repository itself still linked to the worktree's own copy, and a virtual environment is left for the build to make, as `uv sync` or `python -m venv .venv && .venv/bin/pip install -e .` make one, since a copy's scripts would still run the working tree's interpreter. Packages installed above the repository are linked either way, and what git ignores past the 256 MB copied is linked as before. A good run is kept against [its own baseline](./verify.md#good-runs-against-their-own-baseline), the same run under the code without the candidate, and that runs in a worktree of its own too: the candidate's as it was before the candidate went in, copied when a good run first forks and built the same way, so the two differ by the candidate alone, whatever your working tree holds by then. The worktrees are removed once the candidate is decided, and on Ctrl-C. A provider that stays unavailable while blame or verify runs ([gating](./gating.md#when-the-provider-is-unavailable)) stops the repair there, *stopped* with the provider named, exit 3: a candidate it left unverified is neither rejected nor tried after.

Your working tree changes only at the end, with `--apply`, and only by the accepted candidate: its patch is checked first to be that candidate's rewrite and nothing more, as [`shadowlap fix apply`](./cli.md#fix) checks a patch, and its text to be where it was found. Then `--build` runs in the working tree.

One repair runs in a folder at a time. It holds `.shadowlap/repair.lock` while it runs and while it hands its fix over, and a repair started there meanwhile stops before it does anything and says so. A `.shadowlap` that is a link, which a repository could ship to send what a repair writes elsewhere, is refused before the lock is taken, so nothing is made through it. The lock of a repair whose process died on this machine is taken over at once, and the worktree it left is removed. A repair in a container or on another machine that shares the folder is kept apart too, but neither side can check the other's process, so such a lock is never taken over: if a repair died there, delete `.shadowlap/repair.lock`. On Windows, which can't tell a process from one given the same process id since, the lock of a repair that died also waits while a running process has its id: delete it if no repair is running. A `.shadowlap/repair-journal.json`, which a repair that tried candidates in place left when it died, is put back at the start of the next repair when git says it is your checkout's own: a file of this repository that git doesn't track, reached through no link. A repository can ship one, so one that git tracks, or that names a file outside the repository, is left as it is and nothing is put back from it. Even a journal repair takes puts back only the repository's own files, written as a candidate is, and only one that still holds the candidate's text. `shadowlap doctor` reports a journal of either kind.

## Handing it over

| Option | What you get |
|---|---|
| (always) | `.shadowlap/repairs/<id>/`: `fix.patch`, `report.md` (a pull request body: the change, where each run was lost, the evidence, every candidate and why it was dropped), `report.json`, and `goldens/`, a recording of each fixed run |
| `--apply` | The fix left in the working tree |
| `--branch <name>` | A commit with the fix on a new branch, the evidence in its message. Nothing is checked out: HEAD and the working tree stay as they are. The commit is HEAD with the fix, while verify replayed the working tree: when tracked files have uncommitted changes, a warning, `report.md` and the commit message name them (`uncommitted`), so check the branch passes without them, or commit them and repair again |
| `--pr` | With `--branch`: the branch pushed to `origin` and a pull request opened with `gh`, the report as its body. Its title is the fix's commit subject on one line of at most 256 characters, a mention, a reference or a workflow command's start in it split by a word joiner, as the Action titles its fix |
| `--goldens <dir>` | With `--apply` or `--branch`: the recordings also placed in the project, for [`shadowlap test`](./ci.md). The folder is taken from the one repair runs in; with `--branch` it has to be inside the repository, which repair checks before it starts |

Repair prints the command that applies the patch by hand, `git -c core.autocrlf=false apply <patch>`. Git for Windows sets `core.autocrlf`, under which plain `git apply` writes a file with LF back with CRLF on every line, and the file is no longer the one verified. A teammate's patch with LF, for a checkout where the file has CRLF, applies only through that conversion, with plain `git apply`. [`shadowlap fix apply`](./cli.md#fix) applies either, and converts nothing where the patch's lines end as the file's do.

The recordings were made by the fixed code, so `shadowlap test` replays them clean with the fix in place and fails the build if it is ever undone. Together with the patch, they turn a bug into a regression test.

## The repairer

Any model from any vendor, configured rather than built in:

```json
{ "repair": { "repairer": "anthropic:claude-opus-5-5" } }
```

| Value | |
|---|---|
| `anthropic` | Claude Opus 5.5, through the Anthropic SDK, with `ANTHROPIC_API_KEY` or an `ant auth login` profile. Shadowlap doesn't install the SDK for everyone, and asks npm for no peer: `npm install @anthropic-ai/sdk` next to `shadowlap`, or `npm install -g @anthropic-ai/sdk` beside a global one |
| `anthropic:<model>` | Another Claude model, such as `claude-fable-5-1` |
| `openai:<model>` | Any Chat Completions API: OpenAI, OpenRouter, a local server such as Ollama or vLLM (`OPENAI_BASE_URL`, `OPENAI_API_KEY`) |
| `claude-code`, `claude-code:<model>` | Your own [Claude Code](https://code.claude.com), 2.1.248 or later, run in print mode (`claude -p`) in an empty folder, the answer held to a JSON schema and its system prompt replaced from a file. What it reads is the failing runs' content, which an agent's tools filled, so it runs restricted (`--restricted`: managed settings alone, none of your user, project or local settings), with no tools (`--tools ''`, `--disallowed-tools 'mcp__*'`), no MCP server (`--strict-mcp-config`, with none given) and no session kept on disk (`--no-session-persistence`): no hook, permission rule or plugin of yours or a repository's runs on that content. It signs in with your login or an API key in its environment, not an `apiKeyHelper` or `env` of your settings, which it doesn't load; Shadowlap never sees its credentials. Without a model, Claude Code's own default is used; a model is a model's name, never a flag. `SHADOWLAP_CLAUDE` names the binary when `claude` isn't on the PATH |

`--repairer` overrides the config, and `repair.baseUrl` points it at a gateway. Claude is asked with high effort and structured output. On models that support it, the API's server-side fallback answers a policy decline from another model in the same call, and the report names the model that answered. It is called once per repair, so even the most capable model costs little next to the replays.

Its call counts against `--budget` like any other: it is asked only when what is left covers the most asking it could cost, its prompt counted at 3 characters a token (more tokens than English text holds) and the longest answer it may give, 16,000 tokens, at its model's [price](./cli.md#the-configuration-file). Every repairer is held to that answer: the Anthropic request's `max_tokens`, an OpenAI-compatible one's `max_completion_tokens`, and Claude Code's `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (a lower one you set stays). Claude Code may take two turns, so both are counted, the second reading the prompt again with the first answer; its own default model is priced as Opus 5.5. An OpenAI-compatible server that ignores `max_completion_tokens` answers past that bound. When what is left is less, the repair stops before it asks, *stopped* with exit 3, and says what asking could have cost. A model with no price can't be counted beforehand, so it is asked whatever is left, and its cost counts once it answers, when it reports one.

It has 10 minutes to answer, `--repairer-timeout <seconds>` or `repair.timeout` in the config for another limit. Past it, the request is aborted, or Claude Code stopped, and the repair goes on without candidates from it: the report says why (`noRepairer`, *the repairer could not be asked: it did not answer within 10 minutes*), as for any repairer that can't be asked. Ctrl-C stops it too, and the repair ends *stopped*, 128 plus the signal's number.

Claude Code runs in an empty temporary directory, so no project's `CLAUDE.md` reaches the prompt. It runs without the variables of any Claude Code session it was started from, so a repair started inside Claude Code asks a fresh one. Its system prompt is a file (`--system-prompt-file`) and the request goes on stdin, so the command line carries no line break, and on Windows a `claude` npm installed, a batch file, runs through cmd.exe. The cost reported is Claude Code's own estimate.

Without a repairer, repair still tries the fixes that need none (`--stronger`), and says it skipped the rest. When no repairer proposes anything (none is configured, none of the prompt or tool descriptions is in your files to rewrite, or it can't be asked: `claude` not found or not runnable, no Anthropic credentials, a key refused, a server out of reach), the report says why in a few words (`noRepairer`, *the repairer could not be asked: claude was not found*), as its reason for not fixing when there was nothing else to try, and a warning says what to do. An Anthropic repairer is checked before anything is blamed, by asking the Models API about its model with the credentials it would use (no prompt, no tokens): with none to sign in with, or a key the API refuses, repair blames nothing and spends nothing, and ends not fixed with why (*the repairer could not be asked: the Anthropic SDK is not installed*, *no Anthropic credentials*, or *the Anthropic API refused the credentials*), unless `--stronger` leaves a fix that needs no model to look for. Claude Code is checked then too: one whose `claude --version` names a version before 2.1.248, which has no restricted mode, or one your organization's `managed-mcp.json` governs, under which Claude Code won't start with no MCP server, ends the repair the same way (*the repairer could not be asked: Claude Code 2.1.200 can't run a repair restricted*). One that names no version is asked, and an older one rejects `--restricted` with an unknown-option error, which the report names (*this Claude Code has no restricted mode*). Anything else that keeps a repairer from answering (`claude` not found or not runnable, a server out of reach) shows only when it is asked, once blame has run: the repair is kept all the same, with its blames and the fix they opened or joined, and `--json` prints its report. The fix's Repair step and `shadowlap fix show` say the same; the dashboard's Repair from here checks first that `claude` can be found, when Claude Code is the repairer it would ask.

## The fix it reports to

Repair blames each failing run first, and each blame opens or joins a [fix](./blame.md#fixes), so a repair of runs never blamed opens one. The repair is kept with that fix: its report, its directory, and every candidate it tried with why it was dropped. When its `--expect` covers the fix's check, its failing runs, held-out ones included, become the fix's failing runs, and its good runs the fix's good runs. A run given as failing that passes the check as recorded doesn't: its blame finds that when it replays the run, and a run held out from the repairer is judged on its recording and left out of the repair, with a warning.

- When a candidate is accepted, its verification is kept as a verdict of its own. It turns the fix verified when it [counts](./verify.md#verdicts-are-kept) for it: checked under the fix's check, or one that asks for more. With `--apply` the change is already in the working tree, so the fix is applied; it copies no goldens into the project unless `--goldens` says where, and runs no test, which [`shadowlap fix apply`](./cli.md#fix) does later. With `--pr`, the pull request becomes where the fix came from.
- When none is accepted, repair exits 1 and the fix stays open, and `shadowlap fix show` lists each candidate it tried, rejected or set aside, with why.
- When handing the fix over fails part way (a push or `gh pr create` refused, a file changed during the repair, the recordings could not be copied to `--goldens`), repair says why and exits 1, and keeps the repair anyway: `report.json` is written, the fix turns verified, or applied when the change was applied before the failure, and the report's warnings say where the hand-over stopped. Goldens that didn't reach the project are left for `shadowlap fix apply` to copy.

[`shadowlap fix apply <fix>`](./cli.md#fix) hands a verified fix over later: it applies `fix.patch`, copies the recordings in `goldens/` into the project's goldens folder, runs `shadowlap test` on them, and marks the fix applied. A repair logs `repair.accepted` or `repair.empty` in the store's activity, and `fix.applied` for a fix `--apply` applied. Run by a dashboard job, it reports a link to the fix's Repair step.

## Outcomes

| Outcome | Exit | Meaning |
|---|---|---|
| **Fixed** | 0 | A candidate passed the gate. 1 when the hand-over asked for (`--apply`, `--branch`, `--pr`) failed part way |
| **Not fixed** | 1 | No candidate passed; the report lists each and why |
| **No fix to try** | 1 | No failing run was rescued, so there is no passing path to learn from. With `--stronger`, not even a stronger model rescued them: look at the code and the tools. When blame found that no answer of the model's lost the runs (every attempt failed on a write's recorded error again, or the attempts that passed answered as the recording did), the reason says that instead, as the fix's Blame step does, and suggests no stronger model; when no run could be blamed at all (each passed its check when replayed, say), it says why; and when blame settled nowhere (its first probe could not tell, *Not settled from the first model call*, which `shadowlap blame` alone ends with 3), it says what settles it |
| **Stopped** | 3, or 128 + n | `--budget` spent, too little of it left to ask the repairer, or a provider that stayed unavailable: 3. Ctrl-C, a closed terminal or SIGTERM: 128 plus the signal's number (130, 129, 143), whatever the outcome, one that comes while repair removes its last worktree or closes its store too. What was found so far is reported |

## JSON

`--json` prints the whole report on stdout, each candidate with its verification, for scripts and [coding agents](./agents.md):

| Field | |
|---|---|
| `outcome`, `why` | `fixed`, `not-fixed`, `no-diagnosis` (no failing run was rescued) or `stopped`, and why it isn't fixed (`null` when it is) |
| `targets` | Per failing run shown to the repairer: `runId`, `outcome` (`blamed`, `unrescuable`, `stopped`, `passes` when it passed the check as replayed, so there was no failure to blame, or `error` when blame couldn't run), where it was lost (`callNo`, its model call `step` of `steps`), and `range` when its blame pinned no one call: `{ from, to, fromStep, toStep }`, the two calls it was lost between, with `gradual: true` when its check found no drop beyond chance from one to the next (rescue falls by less than the gate's rates apart, or the check could not tell), as [blame](./blame.md#how-it-works) words it (*lost gradually, around model calls #17 and #18*), `callNo` being the first; `null` otherwise. Then the fork that rescued it (`rescuedRunId`) and the model that did when it wasn't the recorded one (`rescuedBy`), `unsettled` (true for an `unrescuable` one only because its blame's first probe could not tell, which is not settled rather than not rescued; absent otherwise), whether a blame already kept was `reused`, what the agent answered there in the recording and in the rescue (`recorded`, `rescued`), and a `note` |
| `holdout`, `good`, `heldOutAutomatically` | The held-out failing runs and the good runs, and whether the held-out ones were taken from `--fixes` because none were named |
| `oracle` | What a passing run must do |
| `repairer`, `noRepairer`, `diagnosis`, `anchors` | The repairer (`provider`, `model`, the model that `served` the answer, its `cost`), or `null` when none answered; why none proposed candidates, in a few words (`no repairer is configured`, `the repairer had nothing it could rewrite`, `the repairer could not be asked: claude was not found`), `null` when one did or none was needed; what it said went wrong; and how many places in your code it could rewrite |
| `candidates` | Each rewrite tried: `id`, `source` (`repairer`, or `model` for a switch to the model that rescued the runs), `strategy`, `why`, the `surface` and `file` it changes, at `offset`, the text `before` and `after`, its `size`, its `state` (`accepted`, `rejected`, `invalid`, `untried`, `build-failed`, `incomplete`), the `reason` it wasn't kept, and its `verify` report, [as `verify --json` prints one](./verify.md#json): the accepted candidate's with the `verifyId` and `fixes` of the verdict kept for it, the others' with `null` and none |
| `accepted`, `patch` | The accepted candidate's `id` and its unified diff, or `null` |
| `cost` | What `blame`, the `repairer` and `verify` cost, in USD, and `judge`, what [judge checks](./judges.md)' calls cost across blame and verify, apart from the agent's (absent when no judge was asked live). `--budget` counts them all |
| `writes` | What write tools did after a fork in every replay: `stub` or `block`, as `--writes` set it. `report.md` says the same |
| `uncommitted` | With `--branch`, only when there were any: the tracked files with uncommitted changes, which verify replayed and the branch does not hold |
| `output` | What was handed over: the repair's `dir`, its `patch` and `report` files, the `goldens` recorded under the fix, whether it was `applied`, and the `branch` and `pr` |
| `warnings` | What the evidence lacks, and where a hand-over stopped |
| `repairId`, `verifyId` | The directory name the repair is kept under, and the verdict kept for the accepted candidate, or `null` |
| `fixes` | Each [fix](#the-fix-it-reports-to) it reported to: `fixId`, `title`, `status`, whether the verdict `counts` for it (`null` without a verdict) and `why` not |
| `error` | Only when the hand-over failed: why |

## Options

| Option | Effect |
|---|---|
| `--fixes <run...>` | The failing runs to repair: ids, prefixes or `label:<name>` |
| `--holdout <run...>` | Failing runs kept from the repairer (default: every other `--fixes` run, when there are two or more) |
| `--keeps <run...>` | Runs that passed and must not get worse, such as `label:good`. One that forks is kept unless it drops 10+ points below its baseline, the same run on the code without the candidate, attempt for attempt, at the gate's risk, up to 200 pairs, as [verify keeps one](./verify.md#good-runs-against-their-own-baseline), and its verdict bounds the drop as verify's does: `drop <= 0.10 (95%)`. `verify.margin` and `verify.max` in the config change the points and the pairs |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0 ([outcome checks](./ci.md#outcome-checks)). A [judge check](./judges.md) is asked live on each attempt, and one whose judge can't be is refused before anything runs, as [verify](./verify.md) refuses it |
| `--repairer <provider:model>` | The model that proposes fixes (default: `repair.repairer` in the config) |
| `--repairer-timeout <seconds>` | How long the repairer may take to answer (default: `repair.timeout` in the config, else 600) |
| `--candidates <n>` | Rewrites to ask for. Default 3 |
| `--stronger <model>` | Rescue with this model when the recorded one can't be, and try switching to it |
| `--scope <name>` | Blame only the model calls of this scope: the agent's, not a simulated user's |
| `--set <key=value>` | Blame's probes set this request field, such as `temperature=1` for an agent recorded at 0, whose answers don't vary when asked again |
| `--gate <json\|@file>` | The gate each candidate's runs are verified by, as for [`verify`](./verify.md#how-a-run-is-judged): by default a run passes at 90% or more and fails at 70% or less, each at 5% risk, up to 80 attempts |
| `--attempts <n>`, `--passes <n>` | A fixed count instead of the gate, such as `--attempts 5 --passes 4` |
| `--max-growth <percent>` | Reject a fix that grows input tokens per run by more than this, its rewrite alone measured before it runs. Default 25 |
| `--build <command>` | Build the agent in each candidate's worktree and in its baseline's, and in the working tree after `--apply` |
| `--apply`, `--branch <name>`, `--pr`, `--goldens <dir>` | Hand-over, above |
| `--budget <usd>` | Stop once this much is spent on blame, the repairer, verification and judge checks; the repairer is asked only when what is left covers the most asking it could cost |
| `--writes`, `--reads`, `--concurrency`, `--timeout`, `--guard`, `-y`, `--json` | As for [verify](./verify.md) |

## Limits

- A fix is a rewrite of the prompt, a tool description, or the model's name. A cause in the harness (parsing, dispatch, state, stop conditions) needs a code change. Blame's report and the repair report are the brief for making it, by hand or with a coding agent, and `shadowlap verify` checks it for free, since a harness fix changes no request.
- Case details are recognised by their form: ids, amounts, addresses. A person's name in a replacement is not caught by the screen. The held-out runs still are.
- One rewrite per candidate. A problem that needs two coordinated edits needs two repairs, or a person.
