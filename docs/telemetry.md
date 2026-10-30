# Telemetry

Shadowlap can send anonymous usage counts to a collector you name. This page is the complete list of what is sent.

**Nothing is sent by default, and the project collects nothing.** The CLI has no default endpoint and Shadowlap runs no collector. Events go out only when `SHADOWLAP_TELEMETRY_URL` points at one. In practice, that means a collector you host yourself to measure usage inside your own organization.

## What is sent

One event per `run`, `replay`, `test` pack, `ui` open and `pack`:

| Field | Example | Notes |
|---|---|---|
| Install id | `123e4567-…` | Random UUID stored in your config directory. In CI, a hash of the repository's numeric id, never its name |
| Version, OS, arch, Node version | `0.1.0`, `darwin`, `arm64`, `22.18.0` | — |
| CI system | `github`, `gitlab`, `other`, none | From environment variables |
| Providers | `["anthropic"]` | Which provider modules received calls |
| SDK languages | `["typescript", "python"]` | From the user agent of what called the sidecar (an SDK, the recorded-input preload, `shadowlap mcp`), as one of `typescript`, `python`, `mcp`, `other` |
| Counts | calls: 30, replayed: 28, live: 2, blocked: 1, stubbed: 0, overridden: 0 | — |
| Divergence type | `request_changed`, or none | The category only |
| Tokens not re-spent | 12000 | From recorded usage |
| Duration, exit code | 900 ms, 0 | — |

## What is never sent

Prompts, messages, tool names, tool arguments or results, file paths, hostnames, run ids, model names, repository names, or anything the agent saw.

The collector rejects any event carrying either of these:

- **A field outside its allowlist, or a value outside its closed sets**, so a client bug cannot leak content.
- **A time before 2025, or more than a day ahead of its own clock**, so no client can keep its events counted as recent.

## Opt out

```sh
export SHADOWLAP_TELEMETRY=0     # or DO_NOT_TRACK=1
```

With a collector configured, the first run prints a one-line notice. `SHADOWLAP_TELEMETRY_URL` sends events to a collector of your own.

## The collector

`@shadowlap/collector` is a Node service with a strict validator, a SQLite store, aggregate stats and a dashboard. The dashboard shows:

- weekly active developers over twelve weeks;
- replays per day, and how many were clean;
- tokens not re-spent;
- CI repositories;
- why replays forked;
- the counts by provider, SDK, OS and version.

It installs nothing but Shadowlap's engine, which has no dependencies of its own. The dashboard runs no scripts. Source: `packages/collector` in the repository.

It ships so that a team running Shadowlap can see its own numbers; whether the dashboard is public is up to whoever hosts it.

## Hosting your own

Install the collector from npm, and start it. It needs Node 22.16 or later, not 23.

```sh
npm install -g @shadowlap/collector
shadowlap-collector
```

These environment variables set it up:

| Variable | What it does | Default |
|---|---|---|
| `PORT` | The port it listens on | 8787 |
| `HOST` | The address it listens on | `0.0.0.0` |
| `COLLECTOR_DB` | Its SQLite file | `./collector.db` |
| `PUBLIC_ORIGIN` | The address its empty dashboard tells clients to send to | — |

Put it behind TLS at a hostname you control, and point the CLI at it with `SHADOWLAP_TELEMETRY_URL=https://your-host/v1/events`. `GET /healthz` is its health check.

### In a container

Point `COLLECTOR_DB` at a directory the process's user can write. With a volume, create the directory and give it to that user before declaring the volume, or the collector can't create its file there:

```dockerfile
RUN mkdir -p /data && chown node:node /data
VOLUME /data
```

## See also

- [Security](https://github.com/devjoinedthechat/shadowlap/blob/main/SECURITY.md): what the collector accepts, and every other check Shadowlap makes.
