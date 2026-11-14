# Coding agents

Claude Code, Codex, Cursor, GitHub Copilot and other coding agents can set shadowlap up for an agent
and debug it the way you would. They record a run, read where it went wrong, change the code, and
replay to check the change, without paying for the model calls that didn't change.

The CLI is their interface, with no MCP server to run: every command they need reads and writes
JSON. What they need to know about it comes packaged in one of two forms:

- **Two [skills](#the-skills)**, which `shadowlap skill install` puts into the project for
  [Claude Code](#claude-code) or for [the other agents](#codex-cursor-copilot-and-others).
- **A [section to paste](#instructions-to-give-it)** into any agent's instructions.

## The skills

Two skills in the [Agent Skills](https://agentskills.io/specification) format, each loaded when a
task calls for it:

| Skill         | For                                                                             |
|---------------|---------------------------------------------------------------------------------|
| `setup-agent` | A project with an agent but nothing recorded yet                                |
| `debug-agent` | Every change to the agent's prompt, tools, model or code, and every failing run |

**`setup-agent`** finds the agent and its tools, and marks what each tool does to the world from the
tool's code. It records a first run (asking first, since a recording runs the agent live), makes its
replay clean, keeps good runs as goldens, and adds the CI check.

**`debug-agent`** checks every change to the agent's prompt, tools, model or code against what the
agent actually did before the change is called done, whether or not anyone asked to debug. It takes
every failing run too: where it went wrong, the commit that broke it, a switch to another model, and
a fix verified.

They are in [coding-agents/claude-code/skills](https://github.com/devjoinedthechat/shadowlap/tree/main/coding-agents/claude-code/skills),
versioned with the CLI.

## Claude Code

A plugin with both skills, which Claude uses when a task calls for them, or on purpose with
`/shadowlap:setup-agent` and `/shadowlap:debug-agent`. Put it into the project:

```sh
shadowlap skill install
```

- **Where it goes.** It writes the plugin to `.claude/skills/shadowlap/` from the copy that comes
  with the CLI, so nothing is downloaded and the skills name the commands your CLI takes.
- **Commit it.** Claude Code loads a plugin there for everyone working on the project, once they
  trust the folder.
- **After upgrading shadowlap,** `shadowlap skill install --force` brings it to your CLI's version.
  Without `--force`, the command leaves alone whatever there isn't this version's copy, and says what
  differs ([`skill`](./cli.md#skill)).

### In every project on your machine

To have it in every project on your machine instead, install it from the repository, which is its own
plugin marketplace, at your CLI's version. The last command moves an earlier install to that
version, which installing again doesn't:

```sh
claude plugin marketplace add devjoinedthechat/shadowlap@v$(shadowlap --version)
claude plugin install shadowlap@shadowlap
claude plugin update shadowlap@shadowlap
```

From a clone, `claude --plugin-dir shadowlap/coding-agents/claude-code` loads it for one session. The
plugin is in [coding-agents/claude-code](https://github.com/devjoinedthechat/shadowlap/tree/main/coding-agents/claude-code),
and its version is the CLI's.

### What Claude runs without asking

While Claude uses a skill, it may run the commands that only read without asking:

| Skill         | Commands it may run without asking                                |
|---------------|-------------------------------------------------------------------|
| `debug-agent` | `shadowlap ls`, `show`, `search`, `diff`, `fix ls` and `fix show` |
| `setup-agent` | `shadowlap ls`, `show` and `doctor`                               |

The grant lasts for the turn in which Claude loads the skill, and ends at your next message.
Everything that runs the agent asks first, as any other command does.

## Codex, Cursor, Copilot and others

The same skills, in the folder the Agent Skills format names for every coding agent. Put them into
the project:

```sh
shadowlap skill install agents
```

It writes them to `.agents/skills/shadowlap-setup-agent/` and `.agents/skills/shadowlap-debug-agent/`
from the copy that comes with the CLI. Codex, Cursor, GitHub Copilot (in VS Code, its CLI and its
coding agent), Gemini CLI, Antigravity, Devin Desktop (formerly Windsurf), OpenCode, Cline, Amp, goose, Zed and Junie read
skills from that folder. So one install covers whichever of them the people on the project use:
commit it.

Any of their names works in place of `agents`, as in `shadowlap skill install cursor`. Kiro reads
only its own folder, so for Kiro:

```sh
shadowlap skill install kiro
```

which writes the same skills to `.kiro/skills/`.

- **Names.** In these folders, which every tool's skills share, each skill's name starts with
  `shadowlap-`, so it can't collide with another tool's.
- **Commands.** The skills leave out the commands Claude Code may run without asking, since each of
  these agents asks before running a command as its own settings say.
- **`--force`** replaces another version's copy, or one edited here, and removes the files of ours
  that this version doesn't have. Skills of other tools in the folder are never touched.
- **In the [dashboard](./dashboard.md),** Settings → Coding agents does the same with
  **Add the skills** on the `.agents/skills` row. The row then reads
  *found · shadowlap-setup-agent, shadowlap-debug-agent* with the version.

## Instructions to give it

For an agent that doesn't read skills, or to keep the instructions in `CLAUDE.md` or `AGENTS.md`,
paste this into the project's instructions file, and adjust the commands:

```md
## Debugging the agent with shadowlap

Agent runs are recorded with shadowlap (`shadowlap run -- <command>`). Check every change to the
agent's prompt, tools, model or code this way before calling it done. To investigate a failing run:

1. `shadowlap ls --json` to find it, `shadowlap show <run> --json` to read it. A call's request and
   response: `shadowlap show <run> --request <call>` and `shadowlap show <run> --response <call>`.
2. Change the code. Then `shadowlap replay <run> --summary-json .shadowlap/replay.json` re-runs the
   agent against the recording: calls that didn't change are served from it for free, and the run
   forks at the first request that changed. Read `summary.divergence` in the JSON to see where and why.
3. A changed system prompt forks at call 1; to test it from a later model call instead, add
   `--prompt-from <call>`. To see what it decides differently at every step without running the
   agent, `shadowlap decisions goldens/* --from-code --json` (rank 1 is a write that changed). To
   see whether a fix holds rather than got lucky, add `--repeat 5`.
   Not sure where it went wrong? `shadowlap blame <run> --expect '<checks>' --json` names the model
   call that lost the run and shows what the model answered there in a fork that passed. `<checks>`
   is what a passing run must do besides exiting 0, as JSON: `{"tools":{"send_email":0}}`.
4. Writes (emails, tickets, payments) are blocked or stubbed after a fork; never pass `--writes allow`.
5. Before finishing, run `shadowlap verify --fixes <runs> --keeps label:good --expect '<checks>'`
   with the failing runs as `<runs>`, and make sure it is accepted; then `shadowlap test goldens/*`.
   A fix inside a tool needs `--live-tool <tool>`.
```

## What an agent uses

The commands a coding agent runs, grouped by what they are for.

### Set up and read runs

| To | Run | Reads |
|---|---|---|
| Set up a project | `shadowlap init --json` | The model SDKs, the framework, the command that starts the agent, each tool with its effect and a suggested one ([fields](./cli.md#init)) |
| Find runs | `shadowlap ls --json [--label bug]` | Run ids, labels, and whether and where each forked ([fields](./cli.md#ls)) |
| Read a run | `shadowlap show <run> --json` | The summary (calls by origin, divergence, cost), every call, and the untrusted reads ([fields](./cli.md#show)) |
| Read one call | `shadowlap show <run> --request <n>` / `--response <n>` | The request as sent, the response as received |
| Search what runs recorded | `shadowlap search <words> --json` | Matching prompts, responses, tool arguments and results |
| Compare two runs | `shadowlap diff <a> <b> --json` | What changed, what made a fork when its flag changed an answer, the first differing request, each run's course after it |

- **`init`** also gives the code that wraps the tools.
- **`ls`** also says whether a run has a command to re-run, came from a pack or a capture, or is an
  attempt with check results.
- **`show`** lists the reads of tools marked untrusted, whose text could carry a prompt injection.

### Check a change

| To | Run | Reads |
|---|---|---|
| Check a change | `shadowlap replay <run> --strict --summary-json out.json` | Exit code 1 on divergence or an early end; the summary in `out.json` |
| Check a prompt change from a later step | `shadowlap replay <run> --prompt-from <call> --summary-json out.json` | As above |
| See what a prompt or model change decides differently | `shadowlap decisions <runs\|goldens> --from-code --json` (or `--model <model>`) | The changed decisions in rank order, writes first, each with the recorded action and the changed one ([fields](./cli.md#decisions)) |
| See whether a fix holds | `shadowlap replay <run> --repeat 5 --summary-json out.json` | Every attempt, and the paths they took |
| Find ids and temp paths that change every run | `shadowlap calibrate --json` | Proposed normalizers |
| Run the recorded tests | `shadowlap test <pack...> --json report.json` | Per recording: result, divergence, checks |

A replay runs the agent's own command, so its output mixes with shadowlap's on the terminal;
`--summary-json` writes the outcome to a file instead. Replays make no model calls until the fork, so
an agent can replay as often as it likes. `decisions` asks each recorded model call again with only
the change, and runs no tool.

### Find and fix a failure

| To | Run | Reads |
|---|---|---|
| Find where a failed run went wrong | `shadowlap blame <run> --expect '<checks>' --json` | The model call that lost the run, and the run id of a fork that passed ([fields](./blame.md#json)) |
| Find the commit that broke a golden | `shadowlap bisect <golden> --good <rev> --json` | The first commit where it fails, and why ([fields](./cli.md#bisect)) |
| Check a fix before calling it done | `shadowlap verify --fixes <runs> --keeps label:good --expect '<checks>' --json` | Accepted or rejected, and for each run whether it is fixed, kept or broken ([fields](./verify.md#json)) |
| Get a verified fix to the prompt | `shadowlap repair --fixes <runs> --keeps label:good --expect '<checks>' --repairer claude-code --json` | The accepted rewrite and its patch, or why none passed; where each run was lost ([details](./repair.md)) |
| See what is being fixed | `shadowlap fix ls --json`, `shadowlap fix show <fix> --json` | Each failure blame opened a fix for ([fields](./cli.md#fix)) |
| Hand over a verified fix | `shadowlap fix apply <fix> --json` | The patch applied, the recordings copied into the goldens, and whether they pass ([details](./cli.md#fix)) |
| Switch the agent to another model | `shadowlap migrate --to <model> --json` | The changed decisions, whether each run still passes, a run's cost before and after, and the patch to the project's files ([fields](./cli.md#migrate)) |
| Hand over a model switch | `shadowlap migrate apply <id> --json` | The config change applied, and each golden that now diverges on `$.model`, with the command that re-records it ([fields](./cli.md#migrate-apply)) |
| Check whether text the agent reads can steer it | `shadowlap injection <run> --json` | Each untrusted read with each payload: obeyed, influenced, ignored or inconclusive (with why) ([details](./injection.md)) |

- **`blame`** also shows what the model answered at that call, in the recording and in the fork that
  passed.
- **`repair`** gives where each run was lost as a brief for a fix in code.
- **`fix ls` and `fix show`** say, for each fix, where its run was lost, how far its fix got, and
  what can be done next.
- **`injection`** also names the tool call that carried the planted canary, and the run's verdict
  against its limits.

shadowlap never passes credentials to the agent's process beyond what it already had, and a replay
reaches a provider only for calls after the fork.

## Kept in step with the CLI

The skills and the section above say which commands to run word for word, so each is tested as an
agent would use it. CI
([coding-agents.yml](https://github.com/devjoinedthechat/shadowlap/blob/main/.github/workflows/coding-agents.yml)):

- runs every command they name against the repository's reference agent, with a scripted fake of the
  model's API;
- checks that the JSON fields they say to read are there, and that the checks they show parse;
- validates the plugin with Claude Code's validator, and every installed copy of the skills with the
  Agent Skills reference validator.

A flag renamed, or a field moved, fails that job before a coding agent meets it. And the copy
`shadowlap skill install` puts into a project is the one that came with your CLI, so the two stay in
step there too.

## See also

- [`shadowlap skill`](./cli.md#skill): the install command's flags and JSON.
- [Blame](./blame.md), [verify](./verify.md) and [repair](./repair.md): the commands a coding agent
  runs to find and fix a failure.
- [Dashboard](./dashboard.md): Settings → Coding agents.
