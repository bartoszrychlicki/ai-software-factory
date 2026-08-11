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
│   ├── mcp/             # local stdio server exposing safe factory projections
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
| `npm run mcp` | start the local MCP stdio server |

CI runs the same baseline from repository root: clean install, doctor, tests,
type-check and build.

## MCP server

The local MCP server lets a trusted desktop or coding assistant inspect the
factory's durable state without scraping Linear or logs. It uses stdio only:
the MCP client starts it as a child process, and the factory does not open a
port or install a background service.

For Claude Code, use an absolute path to this repository:

```shell
claude mcp add ai-factory --env FACTORY_ROOT=<ścieżka> -- <ścieżka>/node_modules/.bin/tsx <ścieżka>/src/mcp/server.ts
```

`FACTORY_ROOT` is required because the server resolves `projects.yaml` and the
durable registry relative to the repository root, regardless of the client's
current working directory.

Clients using an `mcpServers` JSON block can use the equivalent configuration:

```json
{
  "mcpServers": {
    "ai-factory": {
      "command": "/absolute/path/to/ai-software-factory/node_modules/.bin/tsx",
      "args": ["/absolute/path/to/ai-software-factory/src/mcp/server.ts"],
      "env": {
        "FACTORY_ROOT": "/absolute/path/to/ai-software-factory"
      }
    }
  }
}
```

The server exposes exactly these tools:

| Tool | Access | Purpose |
|---|---|---|
| `factory_projects` | read | safe project configuration and limits |
| `factory_health` | read | breaker, poller lease, active runs and hourly cost |
| `queue_overview` | read | active tickets, current gate, owner of the next action and age |
| `ticket_status` | read | one durable run, review/smoke state, errors, budget and human commands |
| `ticket_plan` | read | clipped plan, human summary, triage, critique and research briefs |
| `ticket_attempts` | read | stage attempts, model signature, cost, duration and optional report tail |
| `ticket_create` | write | create a Linear issue in a state of type `backlog` |
| `ticket_enqueue` | write | move an existing backlog issue to `Todo` when explicitly enabled |
| `ticket_comment` | write | add a non-command Linear comment |

Configuration is read from the process environment first and then from the
repository `.env` for missing values:

| Variable | Meaning |
|---|---|
| `FACTORY_ROOT` | repository root; set it when the client starts elsewhere |
| `LINEAR_API_KEY` | enables only the three Linear write tools; reads start without it |
| `LINEAR_PROJECTS` | comma-separated project keys exposed by this MCP process |
| `FACTORY_LIFECYCLE_DB` | optional explicit path to the durable SQLite registry |
| `FACTORY_MCP_ALLOW_ENQUEUE` | must equal `on` to enable `ticket_enqueue` |

The lifecycle database is opened with SQLite's read-only mode. The MCP process
does not create or migrate it, acquire or renew the poller lease, or become a
second lifecycle writer. A missing registry is reported by read tools as a
clear error and never creates an empty database.

Human decision commands are deliberately absent. The MCP server cannot
`/approve`, `/reject`, `/answer`, `/done`, `/fix`, `/replan`, `/restart`,
`/retry`, `/score` or `/scope`; `ticket_comment` rejects any first token that
looks like a slash command, including editor-autoformatted variants. Gates
remain exclusively in Linear.

This is a trusted, single-user local tool, not an authorization boundary.
Anyone who can run the configured MCP client can see plans, review reports and
local repository paths and—when the Linear key is present—create issues or add
comments as that user. Never expose the process remotely or put secrets in MCP
configuration committed to the repository.

## Runtime model

The active runtime is `src/app/poller.ts`. It reconciles Linear, GitHub and
short `factoryJob` executions against `runs/lifecycle.db`. No Mastra workflow
waits for a human, CI or merge, and no workflow is resumed across those gates.
The poller can restart at any stage because attempts and an idempotent outbox
are durable.

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
