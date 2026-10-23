# Shadowlap for Claude Code

A Claude Code plugin with two skills that teach Claude to work on an AI agent with the `shadowlap`
CLI:

- **`setup-agent`** sets Shadowlap up for an agent: it finds the agent and its tools, marks what each
  tool does to the world, records a first run, makes its replay clean, keeps good runs as goldens and
  adds the CI check.
- **`debug-agent`** checks every change to the agent's prompt, tools, model or code against what the
  agent actually did, and debugs a failing run: where it went wrong, the model call or the commit
  that lost it, a switch to another model, and a fix verified before it is called done.

Claude loads each when a task calls for it; `/shadowlap:setup-agent` and `/shadowlap:debug-agent`
load them on purpose. They need the `shadowlap` CLI on the PATH: see the
[quickstart](../../docs/quickstart.md).

## Install

Into the project, where Claude Code loads it for everyone working on it once they trust the folder:

```sh
shadowlap skill install
```

That writes the copy that came with the CLI to `.claude/skills/shadowlap/`: commit it. Nothing is
downloaded, and the skills name the commands your CLI takes. After upgrading Shadowlap,
`shadowlap skill install --force` brings it to the new version.

For every project on your machine instead, from the repository, which is its own plugin
marketplace, at your CLI's version (the last command moves an earlier install to it):

```sh
claude plugin marketplace add devjoinedthechat/shadowlap@v$(shadowlap --version)
claude plugin install shadowlap@shadowlap
claude plugin update shadowlap@shadowlap
```

From a clone, `claude --plugin-dir shadowlap/coding-agents/claude-code` loads it for one session.

The same skills install for Codex, Cursor, GitHub Copilot and the other agents that read
`.agents/skills`:

```sh
shadowlap skill install agents
```

## What it may run without asking

Each skill pre-approves the commands that only read: `shadowlap ls`, `show`, `search`, `diff`,
`fix ls` and `fix show` for `debug-agent`; `shadowlap ls`, `show` and `doctor` for `setup-agent`.
Like any skill's, that grant lasts for the turn in which Claude loads the skill and ends when you send
your next message. Everything that runs the agent (`run`, `replay`, `blame`, `verify`, `test`) asks
first, as any other command does.

## Kept in step with the CLI

The plugin's version is the CLI's, and CI runs every command the skills name against the
repository's reference agent, so a skill never tells Claude to run something the CLI doesn't take.
The same instructions come as a section to paste into `CLAUDE.md` or `AGENTS.md`:
[Coding agents](../../docs/agents.md).
