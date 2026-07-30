# AI Software Factory

An experimental local software factory powered by agents and a durable SQLite
coordinator. Linear provides the queue and human gates, GitHub provides facts
about PR/CI/merge, and Mastra runs only short plan/build/review jobs.

```text
Preflight → Plan → /approve → Build → Test/E2E → Draft PR
          → GitHub CI → In Review → Human merge → Prod smoke → Done
```

## What's in this repo

- [`ai-factory/`](ai-factory/) — the working Mastra application, Linear poller,
  engine adapters, durable run registry, and quality gates;
- [`ai-factory/docs/ticket-flow.md`](ai-factory/docs/ticket-flow.md) — the full
  ticket flow diagram, including retry and recovery paths;
- [`docs/`](docs/) — findings, architectural decisions, and plan history;
- [`ai-factory/projects.yaml`](ai-factory/projects.yaml) — sample
  configuration for projects, checks, and concurrency limits.

## Key properties

- strict, fail-closed plan/review contracts;
- a canonical SQLite registry, durable outbox, and stage-only recovery;
- isolated branches/worktrees without global file reservations;
- deterministic exact-SHA tests and advisory review;
- explicit plan approval, with merge left to a human;
- retesting after a PR head change, cleanup after merge, and a prod smoke test;
- an allowlisted agent process environment that does not inherit factory secrets.

Instructions for running, testing, and installing launchd services are in
[`ai-factory/README.md`](ai-factory/README.md).

> The `projects.yaml` configuration and launchd files reflect the author's local
> setup. Before using them on another host, adjust the paths, repositories,
> Linear states, and engine access policy.
