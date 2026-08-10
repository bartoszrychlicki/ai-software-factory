# Claude Code handoff

Use [AGENTS.md](AGENTS.md) as the shared agent contract and
[README.md](README.md) for setup and architecture.

The current runtime starts in `src/app/poller.ts`, dispatches short jobs from
`src/jobs/factory-job.ts`, and stores canonical state through
`src/lifecycle/store.ts`. `src/legacy/` exists only for v1 read/migration
compatibility and historical tests.

The old 2026-07-20 handoff is archived at
`docs/archive/claude-handoff-2026-07-20.md`; it is not runtime truth.
