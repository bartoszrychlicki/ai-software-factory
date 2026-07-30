# ai-factory

A local software factory with a durable SQLite coordinator. Linear is the queue
and human interface, GitHub is the source of truth for PR/CI/merge, and Mastra
runs only short AI jobs: `plan`, `build`, and `review`, plus `triage`,
`research`, `synthesis`, and `critique` in projects using deep-plan v3.

```text
Preflight → Plan → /approve → Build → Test/E2E → Draft PR
          → GitHub CI → In Review → Human merge → Prod smoke → Done
```

Projects with `planPipeline: v3` (deep-plan) use an extended planning stage:

```text
Preflight → Triage → [solo: Plan] | [deep: Research ×3 in parallel
          → Synthesis (+Rozstrzygnięcia) → Critique (max 1 revision)] → /approve → …
```

No Mastra workflow waits for a human, CI, or merge, and workflows are never
resumed. The poller can be restarted at any stage; canonical state, attempts,
and the idempotent outbox are stored in `runs/lifecycle.db`.

Full diagram: [docs/ticket-flow.md](docs/ticket-flow.md).
BAR-157 architecture decision:
[docs/mastra-lifecycle-spike.md](docs/mastra-lifecycle-spike.md).

## Running and validation

```shell
npm ci
npm run check
npm test
npm run build
```

Development poller:

```shell
FACTORY_ROOT="$(pwd)" npm run poller -- --once
```

Production still uses the `ops/install-launchd.sh` installer. Do not build the
bundle under a running server or start a second Mastra instance on the same
storage.

## Per-host configuration

`projects.yaml` and `routing.yaml` are shared by all hosts. Store
machine-specific values (repository paths, local budget/model experiments) in
optional, **gitignored** files next to the base files:

- `projects.local.yaml` — per-project overrides,
- `routing.local.yaml` — overrides for the `defaults` and
  `projects.<project>` sections (other top-level sections are configuration
  errors).

The short lifecycle comment channel is configured per project with
`progress: off | milestones | verbose` (also in `projects.local.yaml`).
The default `milestones` reports approval, checkpoint, tests, draft PR, CI,
review verdict, and merge; `verbose` adds research, critique, retry/replan, and
degradations. `off` disables only progress comments; gates and final comments
remain enabled.

Semantics: **shallow merge per project/key, local wins**. A key specified in a
`.local` file replaces the entire base key, including objects, so a local
`budget:` must be complete (`maxUsd` **and** `maxMinutes`). Keys not listed in
`.local` retain their base values; a project present only in `.local` is added
in full. Fail-closed: no `.local` file means no overrides, but an existing file
that cannot be parsed or has an invalid shape stops the factory with a hard
error; it is never silently ignored. `getProject` validations (checks,
`ci.requiredChecks`) run on the merged result, so `.local` cannot bypass them.

Example (the production host overrides the repository path, budget, and verify
model):

```yaml
# projects.local.yaml
br-budget:
  repo: /Users/senioraiconsultant/Development/Clients/Bartosz/br-budget
  budget:
    maxUsd: 15
    maxMinutes: 90
```

```yaml
# routing.local.yaml
projects:
  br-budget:
    verify: claude-code/claude-opus-5@high
```

Commit substantive changes shared by all hosts to the base files; `.local` is
only for per-machine differences. Tests read the committed YAML files through a
copy in a temporary directory, so local host overrides do not affect their
results.

### launchd plists without per-host paths

`ops/install-launchd.sh` generates plists from the
`ops/com.ai-factory.{server,poller}.plist.template` templates: npm/node are
detected with `command -v`, `claude` preferably from `~/.local/bin/claude`, the
factory directory from the repository location, and logs under `$HOME`.
Detected node/npm directories are added to the services' `PATH` (launchd starts
with a minimal `PATH`; see the BAR-92 pitfall). Preview the rendered plists
without installing them:

```shell
bash ops/install-launchd.sh --render-only /tmp/ai-factory-plisty
```

## Linear controls

The factory uses only the `Todo → In Progress → In Review → Done`,
`👤 ⛔ Zablokowany` (blocked, waiting for a human), and `Canceled` states.
Changing the phase by dragging a card is not a workflow decision.

- `/approve` — approves the current plan;
- `/reject <reason>` — stops the plan;
- `/answer <answer>` — answers planner questions (at most two rounds; triage
  may ask round 1, and synthesis may ask round 2);
- `/retry` — retries only the stopped stage;
- `/fix [hints]` — runs a builder fix based on review feedback without losing
  the plan or branch; available only at the merge gate with an
  `advisory-fix` verdict, at most twice per generation, after which
  `/replan <reason>` is required; unavailable after merge;
- `/replan <reason>` — invalidates the plan and creates a new generation;
- `/restart` — temporary alias for `/replan`;
- `/done` — confirms manual execution of the approved ops checklist;
- `/score 1-5 [comment]` — rates outcome quality for experiment data (also
  works after Done, for up to 14 days).

The parser tolerates command-name autoformatting by the Linear editor:
surrounding backticks, `*`, `_`, and `~` markers, and trailing punctuation are
removed, so, for example, `` /`approve` ``, `/*approve*`, and `/approve.` work
like `/approve`. The slash remains required, plain text without a slash is
never a command, and the payload after the command token is passed through
unchanged. Practical tip: `Escape` closes Linear's command menu, which can
introduce this autoformatting.

The `plan:solo` / `plan:deep` labels force the planning path in v3 projects.

An author's comment before build changes the input hash and forces a new plan.
During or after build, it stops the process while preserving the branch and
checkpoint. Progress comments carry a factory marker and are excluded from
this input hash.

## Key files

- `src/pipeline/factory-job.ts` — the only short Mastra workflow
  (`plan|build|review|triage|research|synthesis|critique`);
- `src/pipeline/coordinator.ts` — a pure lifecycle state machine;
- `src/pipeline/lifecycle-store.ts` — the v2 registry, attempts, and outbox in
  SQLite;
- `src/metrics/experiments.ts` + `experiment-report.ts` — experiment data and
  reporting for process variants (solo vs deep) and model configurations;
- `src/sources/poll-linear-v2.ts` — preflight, dispatch, reconciliation, and
  GitHub;
- `src/pipeline/preflight.ts` — read-only dependency checks before claim;
- `src/pipeline/process-control.ts` — AbortSignal and TERM/KILL for the process
  group;
- `src/pipeline/legacy-migration.ts` — read-only import of an approved plan,
  checkpoint, and explicitly linked PR from the v1 registry;
- `src/pipeline/scope.ts` — warnings for ordinary deviations and blocking of
  secrets/unapproved protected paths;
- `projects.yaml` and `routing.yaml` — projects, checks, budgets, and adapters
  (plus optional gitignored per-host `*.local.yaml`; see the section above).

`ticket-pipeline.ts`, `poll-linear.ts`, and `run-registry.ts` remain legacy code
for reading/migration tests, but they are not connected to the runtime.

## Guarantees

- Build creates one checkpoint. A missing CLI final response, timeout, or login
  error stops the stage without automatically starting a second builder.
- Tests and E2E run without AI on a fresh checkout of the exact SHA, in a
  separate detached process (`test-runner.ts`), so they do not block the poller
  loop and survive its restart.
- A Mastra job stuck beyond its role budget plus grace ends with `JOB_STALLED`
  (cancel + `/retry`); it never hangs indefinitely.
- After FAIL, a builder fix is created only after `/retry`.
- `factory.files` is an expectation. An additional ordinary file produces a
  warning; a secret, unapproved workflow/ops/migration, AND files executed by
  the test stage (package.json, lockfiles, test/build configs, `scripts/`)
  block publication. Per project: `scope.protected` in `projects.yaml`.
- The agent does not receive `SSH_AUTH_SOCK`; only the factory performs
  push/publish.
- A PR is identified only by the durable `prUrl`; historical comments are
  ignored. Publish detects an existing branch/draft PR.
- Every PR head SHA change invalidates test/CI and runs a scope audit plus tests
  of the new SHA, never a full rebuild.
- AI review is advisory and may retry only the review once. Review never
  dispatches the builder on its own; after review, the builder runs only on an
  explicit human `/fix` command, at most twice per generation, after which
  `/replan` is required.
  The reviewer is never the same engine as the builder (`review.diverse` in
  routing.yaml), and `mark-pr-ready` is emitted only AFTER the verdict; the
  reviewer's comment exists before the PR leaves draft.
- `Done` for a code ticket requires the merge of the exact tracked PR. A smoke
  FAIL blocks an already merged ticket without automatic rollback.
- The budget is shared by all short jobs for the ticket; cost is counted even
  for engines without a report (a Codex token estimate or a time-based estimate
  — `cost_source` in stage_attempts).
- The circuit breaker (a series of failures / hourly cost) pauses claims for new
  tickets; the outbox dead letter always sends a notification; `lifecycle.db`
  has a daily backup, and a second poller on the same database refuses to start.
- Two tickets with colliding `planFiles` do not build concurrently; the later
  one waits (⏸️ comment) and starts automatically after the PR holding the files
  is closed.
- Deep-plan v3: a triage failure degrades to the solo path (never blocks); one
  research role failing after 1 auto-retry produces an explicit ⚠️ degradation
  at the gate; critique is advisory (engine ≠ synthesis) with a ONE-revision
  limit; all degradations are visible in the `/approve` comment together with
  the cost.
- Every Done records an experiment row (`runs/experiments.jsonl`) with the
  process variant, per-stage costs, and model signatures from actual attempts;
  `/score 1-5` attaches the human rating. Report:
  `npx tsx src/metrics/experiment-report.ts`.
