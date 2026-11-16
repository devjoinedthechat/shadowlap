---
name: setup-agent
description: Set up shadowlap for an AI agent, so its runs can be recorded, replayed, debugged and tested (the shadowlap CLI). Use it when a project has an agent that calls a model but no shadowlap.config.json or .shadowlap folder yet, or when asked to record an agent's runs, add replay tests or goldens for it, or check it in CI. It finds the agent and its tools, marks what each tool does to the world, records a first run, makes its replay clean, and keeps good runs as goldens that CI replays offline.
license: Apache-2.0
compatibility: Needs the shadowlap CLI on the PATH (Node.js 22.17 or later, not 23), run in the agent's project.
allowed-tools: Bash(shadowlap ls *) Bash(shadowlap show *) Bash(shadowlap doctor *)
metadata:
  version: 0.1.0
---

# Setting up shadowlap for an agent

shadowlap records every model and tool call an agent makes (`shadowlap run -- <command>`), then replays the agent's real code against the recording: calls that didn't change are served from it at no cost, and the run forks at the first request that changed and runs live from there. Two things make a replay safe and exact, and setting up is mostly getting them right: shadowlap must know what each tool does to the world, and the values that change on every run must be masked. Read the JSON of the commands below (`--json`, or `--summary-json` for a replay) rather than their text.

## 1. Find the agent and its tools

`shadowlap init --json` reads the project's source and runs nothing; it writes only an empty `shadowlap.config.json`, when there is none. It gives back the model SDKs (`providers`), the framework (`frameworks`), the package manager (`packageManager`), the command that starts the agent (`command`), every tool definition it found (`tools`, each with its `effect`, a `suggested` one and whether it is `wrapped`), the code that wraps the tools through the project's framework (`wrap`), and for a Claude Agent SDK project where each query is fenced (`fence`). A model client built with a literal base URL is listed in `hardcodedBaseUrls`: shadowlap can't redirect it, so its calls would go unrecorded; have it read the base URL from the environment instead.

## 2. Mark what each tool does

A replay decides by a tool's effect whether it may run again after a fork, so every tool needs one:

- **pure**: its result depends only on its arguments (a calculation, a parse).
- **read**: it reads outside state and changes nothing (a search, a query, a file read).
- **write**: it changes something outside (sends an email or a message, opens a ticket, takes a payment, writes a file or a row).

Decide from the tool's code, not its name: the suggestion goes by the first verb of the name alone. A tool that both reads and writes, or one you can't be sure of, is a write: a write never runs again after a fork unless the replay allows writes (`--writes allow`), while a write marked as a read would send its email again. Install the package the `wrap` code imports with the project's `packageManager`, apply the code with the effects you chose where the tools are defined (the Claude Agent SDK's fence goes on the options its query takes), then run `shadowlap init --json` again: no tool should be left in `unwrapped`, and every `fence` entry should name where its query is fenced.

A read that brings outside text in (a web page, an email, a support ticket) could carry a prompt injection. Mark it untrusted in the wrapper's options, or by its name in `shadowlap.config.json`, so injection tests know where to plant:

```json
{ "tools": { "fetch_page": { "trust": "untrusted" } } }
```

## 3. Record a run

`shadowlap run -- <command>` runs the agent the way it always runs, with every call recorded. Its model calls are live and cost what they always cost, and its tools act for real: ask the user before the first run, saying which task you would give it, and point tools that write at a test account or a sandbox where there is one. Use the command `init` found unless they name another.

`shadowlap ls --json` lists the run, newest first, and `shadowlap show <run> --json` reads it: every model call and every wrapped tool should be among its `calls`. When some are missing, or the run didn't start, `shadowlap doctor --json` checks the setup, each check with its `verdict` and `detail`.

## 4. Make the replay clean

`shadowlap replay <run> --summary-json <file>` with nothing changed must give a `summary.divergence` of `null`. When it forks anyway, a value the agent makes anew on every run changed (a request id, a timestamp, a temp path): `shadowlap calibrate <run> --write --json` replays the run until it is clean and adds a normalizer for each such value to `shadowlap.config.json`. Then replay again. A value the agent's own code makes is better made through the SDK's clock, random and id helpers, which record it.

## 5. Keep good runs as goldens

When a run did what it should, keep it:

- `shadowlap label <run> good` marks it as a run a change must keep passing.
- `shadowlap pack <run> goldens/<name>` writes it into the repository as a folder to commit, with its `.gitattributes`. A golden holds the prompts and tool results as recorded, after the project's redaction rules: before committing one, add rules to `shadowlap.config.json` for anything private it holds.
- `shadowlap test goldens/* --json <file>` replays every golden offline, with no key and no model call, and each must pass. What a passing run must do besides exiting 0 goes in `shadowlap.config.json` by folder, as `"tests": {"goldens/*": {"expect": <checks>}}`, with checks such as `{"tools":{"send_email":1}}` (sends exactly one email) or `{"answer":{"includes":"refund"}}`.

## 6. Check it in CI

On GitHub, the shadowlap action replays the goldens on every push and pull request; add it after the steps that build the agent, with the version `shadowlap --version` prints:

```yaml
- uses: devjoinedthechat/shadowlap@v<version>
  with:
    version: <version>
    recordings: goldens/*
```

In any other CI, run `shadowlap test goldens/* --junit <file>` once the agent is built. A golden replays offline, so the job needs no provider key.

Once the replay is clean and the goldens pass, the project is set up: debugging a run and checking a change to the agent are the work of shadowlap's debug skill.
