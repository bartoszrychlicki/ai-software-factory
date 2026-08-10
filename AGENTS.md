# Repository instructions for coding agents

Imported Claude Cowork project instructions are preserved below as current
repository guidance.

## First rule for Mastra work

Load the local `mastra` skill before changing Mastra APIs or configuration.
Do not rely on cached framework knowledge; verify APIs against the installed
version and embedded documentation.

## Working from this repository

- Run commands from repository root; there is one package and one lockfile.
- Use `npm run dev` and `npm run build`, not direct `mastra` CLI commands.
- Register workflows and other Mastra primitives in `src/mastra/index.ts`.
- Treat `src/app`, `src/jobs`, `src/lifecycle`, `src/execution` and
  `src/adapters` as the active runtime.
- Treat `src/legacy` as v1 read/migration compatibility. Do not add new runtime
  behavior there.
- Put deterministic tests in `test/` and run `npm run verify` before handoff.
- Never commit `.env`, `*.local.yaml`, `runs/`, databases, generated output or
  credentials.
- Keep current documentation under `docs/architecture`, accepted decisions
  under `docs/adr`, plans under `docs/roadmap`, and superseded material under
  `docs/archive` with a historical-status banner.

## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)
- [Skills Discovery](https://mastra.ai/.well-known/skills/index.json)
