# AI Software Factory

Experimental, local-first software delivery factory built with Mastra, Linear,
GitHub and isolated Git worktrees. SQLite owns the durable lifecycle; Mastra
runs short AI jobs, while every consequential step remains human-gated.

```text
Preflight → Plan → /approve → Build → Test/E2E → Draft PR
          → GitHub CI → In Review → Human merge → Prod smoke → Done
```

## Can I clone and run it?

Yes. A fresh clone can install, validate, test, build and open Mastra Studio
without secrets or access to the author's filesystem. Connecting the live
poller additionally requires your own Linear workspace, GitHub repositories
and at least one supported coding-agent CLI.

The repository is public, but the factory is still an experimental developer
tool. Start with a disposable repository and keep the Studio/API on a trusted
local network.

### Prerequisites

- Node.js `>=22.18` and npm;
- Git;
- optional for live automation: GitHub CLI plus supported coding-agent CLIs
  authenticated on your machine; a complete build/review cycle needs two
  distinct engines because reviewer and builder may not be the same engine;
- optional for the live queue: a Linear API key and matching workflow states.

### Five-minute setup

```shell
git clone https://github.com/bartoszrychlicki/ai-software-factory.git
cd ai-software-factory
npm ci
npm run doctor
npm run verify
npm run dev
```

`npm run dev` starts Mastra Studio and the API. It does **not** start the Linear
poller, claim tickets or modify another repository.

## Connect your own projects

Keep secrets and machine-specific paths in ignored local files:

```shell
cp .env.example .env
cp projects.local.example.yaml projects.local.yaml
cp routing.local.example.yaml routing.local.yaml
```

Then:

1. put your `LINEAR_API_KEY` and project keys in `.env`;
2. replace example repository paths in `projects.local.yaml`;
3. select agent CLIs/models available locally in `routing.local.yaml`, keeping
   build and review on distinct engines;
4. run `npm run doctor` again;
5. keep `npm run dev` running and, in a second terminal, use
   `npm run poller -- --once` for the first controlled tick.

Committed `projects.yaml` and `routing.yaml` are portable defaults. Relative
repository paths are resolved from the config file. A local file applies a
shallow override; invalid local YAML fails closed instead of being ignored.

Do not point a first experiment at a production repository. The factory can
create worktrees, branches, commits and draft pull requests after the explicit
`/approve` gate.

## Repository map

```text
.
├── src/
│   ├── app/             # live poller entrypoint
│   ├── jobs/            # short Mastra factory job
│   ├── lifecycle/       # state machine, SQLite store, commands and policies
│   ├── execution/       # worktrees, checks, CI, scope and smoke tests
│   ├── adapters/        # Linear, Mastra and coding-agent integrations
│   ├── config/          # projects and routing loaders
│   ├── observability/   # metrics, budgets, experiments and notifications
│   ├── mastra/          # Mastra registration and storage wiring
│   └── legacy/          # v1 read/migration compatibility; not production runtime
├── test/                # deterministic Node test suite
├── docs/
│   ├── architecture/    # current system behavior
│   ├── adr/             # accepted architecture decisions
│   ├── roadmap/         # planned work
│   └── archive/         # historical plans; not runtime truth
├── ops/                 # optional macOS launchd installation
├── scripts/             # repository diagnostics
├── projects.yaml
└── routing.yaml
```

There is one package, one lockfile and one active `docs/` tree at repository
root. The previous nested `ai-factory/` layout is retained only as an ignored
transition path on existing hosts; a fresh clone never creates it.

## Useful commands

| Command | Purpose |
|---|---|
| `npm run doctor` | check prerequisites and portable configuration |
| `npm test` | run the deterministic test suite without AI calls |
| `npm run check` | TypeScript type-check |
| `npm run build` | build Mastra Studio/server |
| `npm run verify` | doctor + tests + type-check + build |
| `npm run dev` | start local Mastra Studio/API |
| `npm run poller -- --once` | execute one live Linear polling cycle |

CI runs the same baseline from repository root: clean install, doctor, tests,
type-check and build.

## Runtime model

The active runtime is `src/app/poller.ts`. It reconciles Linear, GitHub and
short `factoryJob` executions against `runs/lifecycle.db`. No Mastra workflow
waits for a human, CI or merge, and no workflow is resumed across those gates.
The poller can restart at any stage because attempts and an idempotent outbox
are durable.

When a ticket finishes, is canceled or retires a generation, the poller
overwrites `runs/<ticket>/przebieg.md` with the ticket's complete transition
timeline, human-triggered decisions, attempt costs and links to per-job
artifacts. This is a local diagnostic artifact only; `runs/` remains ignored
and nothing from the log is published back to Linear.
`FACTORY_RUNS_ROOT` moves all runtime artifacts together: the lifecycle
database, its backups, test results, per-job artifacts and `przebieg.md`.

Projects using `planPipeline: v3` extend planning with triage, three parallel
research roles, synthesis and one critique/revision round. The human still
approves the single resulting plan before any build begins.

Operator commands are explicit: `/approve`, `/reject`, `/answer`, `/retry`,
`/fix`, `/replan`, `/done` and `/score`. Moving a card alone is not interpreted
as arbitrary natural-language intent.

Important guarantees:

- preflight is read-only and happens before a ticket is claimed;
- planning and review run in detached exact-SHA checkouts;
- build uses a ticket-specific worktree and creates one checkpoint;
- tests run from a fresh checkout of the exact candidate SHA;
- publishing never force-pushes;
- review is advisory and cannot dispatch a builder by itself;
- a code ticket reaches Done only after the exact tracked PR is merged;
- secrets, workflows, ops and migrations are protected by scope checks;
- cost/time budgets, stalled jobs, dead letters and a single-writer lease fail
  closed.

See the [documentation index](docs/README.md), the
[ticket lifecycle](docs/architecture/ticket-flow.md) and
[SQLite lifecycle ADR](docs/adr/0001-sqlite-lifecycle-owner.md) for details.

## Host service

macOS users can preview launchd files without installing anything:

```shell
bash ops/install-launchd.sh --render-only /tmp/ai-factory-plists
```

Installing or migrating a host service is intentionally separate from the
clone-and-explore path because it handles local secrets and durable runtime
state. Existing hosts using the old nested layout should follow the
[copy-only migration guide](docs/operations/migrate-nested-layout.md).

## Security and limitations

Do not commit `.env`, `*.local.yaml`, `runs/`, databases or generated Mastra
output. Do not expose the local Studio/API directly to the public internet.
Dependency alerts and responsible disclosure guidance live in
[SECURITY.md](SECURITY.md).

## Contributing

Run `npm run verify` before opening a pull request. Keep active design notes in
the appropriate `docs/` section and move superseded plans to `docs/archive/`
with a historical-status banner.
