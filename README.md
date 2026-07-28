# AI Software Factory

Eksperymentalna, lokalna fabryka software oparta na agentach i trwałym
koordynatorze SQLite. Linear dostarcza kolejkę i bramki człowieka, GitHub fakty
o PR/CI/merge, a Mastra wykonuje wyłącznie krótkie joby plan/build/review.

```text
Preflight → Plan → /approve → Build → Test/E2E → Draft PR
          → GitHub CI → In Review → Human merge → Prod smoke → Done
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

- ścisłe, fail-closed kontrakty plan/review;
- kanoniczne registry SQLite, trwały outbox i stage-only recovery;
- izolowane branche/worktree bez globalnych rezerwacji plików;
- deterministyczne testy exact-SHA i advisory review;
- jawna akceptacja planu oraz merge pozostawiony człowiekowi;
- ponowne testy po zmianie PR head, sprzątanie po merge i prod smoke;
- allowlista środowiska procesów agentów bez dziedziczenia sekretów fabryki.

Instrukcje uruchomienia, testowania i instalacji usług launchd są w
[`ai-factory/README.md`](ai-factory/README.md).

> Konfiguracja `projects.yaml` i pliki launchd pokazują lokalny setup autora.
> Przed użyciem na innym hoście należy dostosować ścieżki, repozytoria, stany
> Lineara oraz politykę dostępu silników.
