# AI Software Factory

Eksperymentalna, lokalna fabryka software oparta na agentach i trwałym workflow
Mastra. Linear dostarcza kolejkę oraz bramki decyzyjne, role planner/builder/
verifier/reviewer pracują przez adaptery CLI, a każdy ticket otrzymuje izolowany
Git worktree i audytowalne artefakty przebiegu.

```text
Linear Todo → intake/outbox → plan → human gate → build → verify
            → review → PR → human merge → cleanup → Done / prod smoke
```

## Co znajduje się w repo

- [`ai-factory/`](ai-factory/) — działająca aplikacja Mastra, poller Lineara,
  adaptery silników, trwały rejestr runów i quality gates;
- [`ai-factory/docs/ticket-flow.md`](ai-factory/docs/ticket-flow.md) — pełny
  diagram przepływu ticketu, ścieżki retry i recovery;
- [`docs/`](docs/) — findings, decyzje architektoniczne oraz historia planu;
- [`ai-factory/projects.yaml`](ai-factory/projects.yaml) — przykładowa
  konfiguracja projektów, checków i limitów współbieżności.

## Najważniejsze własności

- ścisłe, fail-closed kontrakty plan/verify/review;
- trwały outbox i odzyskiwanie workflow po restarcie;
- izolowane branche/worktree i rezerwacja plików między ticketami;
- niezależne verify i review na pełnym diffie brancha;
- jawna akceptacja planu oraz merge pozostawiony człowiekowi;
- pre-merge re-verify, sprzątanie po merge i opcjonalny prod smoke;
- allowlista środowiska procesów agentów bez dziedziczenia sekretów fabryki.

Instrukcje uruchomienia, testowania i instalacji usług launchd są w
[`ai-factory/README.md`](ai-factory/README.md).

> Konfiguracja `projects.yaml` i pliki launchd pokazują lokalny setup autora.
> Przed użyciem na innym hoście należy dostosować ścieżki, repozytoria, stany
> Lineara oraz politykę dostępu silników.
