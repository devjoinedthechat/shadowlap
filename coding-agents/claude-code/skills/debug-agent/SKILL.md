---
name: debug-agent
description: Debug, fix and check a change to an AI agent whose runs Shadowlap records (the shadowlap CLI; shadowlap.config.json or a .shadowlap folder in the project). Use it to find a failing run, read where it went wrong, replay a code or prompt change against what the agent actually did, find the model call that lost the run, and verify a fix before calling it done.
license: Apache-2.0
compatibility: Needs the shadowlap CLI on the PATH (Node.js 22.13 or later), run in the agent's project.
allowed-tools: Bash(shadowlap ls *) Bash(shadowlap show *) Bash(shadowlap search *) Bash(shadowlap diff *) Bash(shadowlap fix ls *)
---

# Debugging an agent with Shadowlap

This project records its agent's runs with Shadowlap: `shadowlap run -- <command>` records every model and tool call, and a replay re-runs the agent's real code against the recording. Calls that didn't change are served from it at no cost; the run forks at the first request that changed, runs live from there, and blocks write tools (emails, tickets, payments). Read the JSON of the commands below that give it (`--json`, or `--summary-json` for a replay) rather than their text. A run id can be shortened to any unique prefix.

## Find the run

- `shadowlap ls --json` lists runs, newest first, with their `status`, `labels` and where each forked (`forkedAt`). `shadowlap ls --label bug --json` keeps the runs labelled `bug`.
- `shadowlap show <run> --json` prints the run, its summary and every call. One call's request as sent and response as received: `shadowlap show <run> --request <call>` and `shadowlap show <run> --response <call>`, with a call number from `show`.
- `shadowlap search <words> --json` finds prompts, responses, tool arguments and tool results across runs. It exits 1 when nothing matches.
- `shadowlap fix ls --json` lists the failures already being fixed: where each run was lost and how far its fix got.

## Check a change

1. Change the code, then run `shadowlap replay <run> --summary-json <file>`. The agent's output mixes with Shadowlap's on the terminal, so read the file: `summary.divergence` is `null` when every request matched, and otherwise names the first call whose request changed and how, or where the replay ended early.
2. A changed system prompt or tool list changes every request, so the replay forks at the first model call. To apply it from a later model call instead: `shadowlap replay <run> --prompt-from <call> --summary-json <file>`.
3. To see what a prompt or tool change decides differently before running anything: `shadowlap decisions goldens/* --from-code --json` asks each model call the goldens recorded again, with the system prompt and tools the working tree sends, and gives each changed decision a `rank`: 1 for a write tool added, removed or called with other arguments, 2 for a change in when the agent stops or hands over, or in its words where a judge check reads them otherwise. No tool runs, so nothing reaches the world; later steps are judged in the recorded run's state, so verify what it flags.
4. A fix inside a tool changes no request, so its old result would replay: `shadowlap replay <run> --live-tool <tool> --summary-json <file>` runs that tool live.
5. Everything after a fork runs live, so one good attempt proves little: `shadowlap replay <run> --repeat 5 --summary-json <file>` runs it five times and reports the paths the attempts took.
6. A replay that forks on a value that changes on every run (an id, a timestamp, a temp path) needs a normalizer: `shadowlap calibrate <run> --json` proposes them, and `--write` adds them to `shadowlap.config.json`.
7. Never pass `--writes allow`: it would let a replay send again the emails and payments the recording already made.

## Find where a failed run went wrong

`shadowlap blame <run> --expect '<checks>' --json` names the model call that lost the run (`blamed`), and what the model answered there in the recording and in a fork that passed (`contrast`: its `recorded` and `rescued` answers, and that fork's `rescuedRunId`). `<checks>` is what a passing run must do besides exiting 0, as JSON: `{"tools":{"send_email":0}}` never sends an email, `{"tools":{"escalate":">= 1","issue_refund":0}}` escalates and never refunds, `{"answer":{"includes":"refund"}}` mentions the refund in its last reply. An `outcome` of `unrescuable` means no model answer saves the run: the fault is in the code, or in what a tool returned.

## Before calling it done

- `shadowlap verify --fixes <runs> --keeps label:good --expect '<checks>' --json` replays the failing runs, which must now pass, and the runs labelled `good`, which must still pass, under the code in the working tree. The change holds when `verdict` is `accepted` (exit 0). Label a run that behaved as it should with `shadowlap label <run> good`.
- `shadowlap test goldens/* --json <file>` replays the project's goldens offline (the runs packed into `goldens/`, or wherever the project keeps them): a changed request, a failed check or a non-zero exit fails one. Keep them passing.
- `shadowlap diff <a> <b> --json` compares two runs call by call: what changed about them as a whole, and the first request that differs. It exits 1 when they differ.
