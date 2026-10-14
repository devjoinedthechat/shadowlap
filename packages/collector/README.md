# @shadowlap/collector

A telemetry collector for Shadowlap, for anyone who wants to run one. One Node process, one SQLite file, no dependencies. The project hosts no collector, and the CLI sends nothing until `SHADOWLAP_TELEMETRY_URL` names one.

- `POST /v1/events`: accepts a batch from the CLI. Every field is validated against a closed allowlist (event types, providers, SDK languages, OS/arch sets, integer counts, version patterns). Any unexpected key or free-text value is rejected with a 400, so the collector cannot store prompts, paths or names even if a client is buggy.
- `GET /v1/stats`: aggregate JSON (active developers, replays and their clean rate, tokens not re-spent, divergence types, providers, SDKs, versions, a 30-day daily series).
- `GET /`: the public dashboard, server-rendered from the same aggregates: weekly active developers over 12 weeks with the week-over-week change, replays per day split clean and forked, tokens not re-spent, CI repositories, and breakdowns by divergence type, provider, SDK, OS, CI system and version. No scripts, and the response's Content-Security-Policy forbids them. Light and dark follow the system.
- `GET /healthz`.

Limits: 64 KB bodies, 50 events per batch, 60 requests per minute per client address. Aggregates are cached for a minute and refreshed whenever a batch arrives.

To work on the dashboard, `node packages/collector/scripts/preview.mjs` serves it with twelve weeks of synthetic usage from an in-memory store (`--empty` for the first-day state). `PUBLIC_ORIGIN` sets the URL the empty state tells clients to send to.

## Run

```sh
npm run build
PORT=8787 COLLECTOR_DB=./collector.db node packages/collector/bin/shadowlap-collector.js
```

Or the Dockerfile in this directory (mount a volume at `/data`). Put it behind TLS at a hostname you control, and point clients at it with `SHADOWLAP_TELEMETRY_URL`.

## Deploy

One small machine with a persistent disk is enough for a long time: events are a few hundred bytes and the collector serves aggregates from SQLite.

- **Fly.io**: `fly.toml` in this directory. From the repository root: `fly launch --copy-config --config packages/collector/fly.toml --no-deploy`, `fly volumes create collector_data --size 1 --region ams`, `fly deploy --config packages/collector/fly.toml`, then `fly certs add <host>` for a domain you control and add the CNAME it prints.
- **Render**: `render.yaml` in this directory is a Blueprint (Docker runtime, 1 GB disk at `/data`, health check on `/healthz`). Render detects a Blueprint only at the repository root, so copy it there in your own fork, then add the custom domain on the service.
- **Anything with Docker**: `docker build -f packages/collector/Dockerfile -t shadowlap-collector .` and run it with a volume at `/data` behind a TLS proxy.

After the first deploy, open `/` for the dashboard and `/healthz` for the check, then point clients at it with `SHADOWLAP_TELEMETRY_URL=https://your-host/v1/events`. The CLI has no default collector and the project runs none, so `DEFAULT_TELEMETRY_URL` stays empty.

## What clients send

See `packages/cli/src/telemetry.ts`. Clients are opt-out (`SHADOWLAP_TELEMETRY=0`, `DO_NOT_TRACK=1`), show a one-time notice, and send counts and versions only.
