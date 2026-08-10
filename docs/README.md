# Documentation index

This is the only active documentation tree. Start with the repository
[README](../README.md) for installation and local exploration.

| Section | Document | Status |
|---|---|---|
| Architecture | [Ticket lifecycle](architecture/ticket-flow.md) | Current behavior |
| ADR | [SQLite owns lifecycle](adr/0001-sqlite-lifecycle-owner.md) | Accepted decision |
| Roadmap | [Development plan 2026](roadmap/development-plan-2026.md) | Direction, verify against code |
| Operations | [Migrate the former nested layout](operations/migrate-nested-layout.md) | Existing hosts only |
| Archive | [2026-07-17 findings](archive/2026-07-17-findings-and-plan.md) | Historical |
| Archive | [2026-07-18 plan v2](archive/2026-07-18-plan-v2.md) | Historical |
| Archive | [Claude handoff 2026-07-20](archive/claude-handoff-2026-07-20.md) | Historical |

Documentation policy:

- architecture describes the code that runs now;
- ADRs record accepted decisions and should not be silently rewritten;
- roadmap items are intentions, not proof of implementation;
- operations documents describe explicit host changes and their safety gates;
- archive content may contain old paths and designs and must not be used as
  runtime truth.
