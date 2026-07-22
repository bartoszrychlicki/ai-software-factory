# ai-factory

Lokalna fabryka software: Linear jest kolejką i interfejsem bramek człowieka,
Mastra prowadzi trwały workflow ticketu, a adaptery CLI realizują role planner,
builder, verifier i reviewer w izolowanych worktree.

Pełny, aktualny diagram i opis stanów: [docs/ticket-flow.md](docs/ticket-flow.md).
Wynik bramki trwałości BAR-157: [docs/mastra-lifecycle-spike.md](docs/mastra-lifecycle-spike.md).

## Uruchomienie

Lokalna usługa działa z wcześniej zbudowanego bundle'a razem z Mastra Studio,
bez hot reloadu:

```shell
npm ci
npm run check
npm test
bash ops/install-launchd.sh
```

Instalator zatrzymuje poller, sprawdza niedokończone runy, zatrzymuje serwer i
dopiero wtedy buduje `.mastra/output`. Waliduje pliki wejściowe bundle'a oraz health
check API i Studio; poller startuje dopiero po gotowości obu endpointów. Nie
uruchamiaj osobnego `npm run build` przy działających usługach — Mastra regeneruje
katalog output destrukcyjnie.

Tryb developerski (`npm run dev`) jest wyłącznie do pracy lokalnej. Hot reload
nie może być używany podczas aktywnego runu ticketu.

## Najważniejsze pliki

- `src/pipeline/ticket-pipeline.ts` — graf workflow i bramki jakościowe,
- `src/sources/poll-linear.ts` — orkiestracja Lineara, adopcja runów i merge watcher,
- `src/sources/mastra-client.ts` — sprawdzany klient start/resume/cancel,
- `src/pipeline/run-registry.ts` — trwały stan ticketu i outbox komend,
- `src/pipeline/quality.ts` — wspólny runner checks/e2e i pełny diff brancha,
- `src/pipeline/github-ci.ts` — gate wymaganych checks dla dokładnego PR head SHA,
- `src/pipeline/scope.ts` — porównanie faktycznych zmian z kontraktem `plan.files`,
- `projects.yaml` — repozytoria, limity, checks i prod smoke,
- `routing.yaml` — routing ról do adapterów silników,
- `runs/<ticket>/<run>/` — artefakty audytowe konkretnego przebiegu.

## Zasady bezpieczeństwa

- Plan, verify i review kończą się ścisłym blokiem `factory`; brak/niepoprawny
  kontrakt jest wynikiem negatywnym.
- Build działa w osobnym worktree. Codex ma sandbox `workspace-write`; role
  read-only dostają sandbox/whitelistę narzędzi.
- Procesy agentów dostają allowlistę zmiennych środowiskowych, bez tokenów
  Lineara, storage i powiadomień.
- Niesandboxowany Kimi jest domyślnie wyłączony i wymaga jawnego
  `FACTORY_ALLOW_UNSANDBOXED_KIMI=1`.
- Merge pozostaje decyzją człowieka. Fabryka publikuje draft PR, wykonuje review,
  re-verify po przesunięciu `main` i sprząta dopiero po merge/zamknięciu.
- Każdy nowy SHA po synchronizacji z `main` lub poprawce review ponownie przechodzi
  checks/e2e i acceptance verification. `PR ready` wymaga `sha === verifiedSha`
  oraz zielonego GitHub CI dla tego samego SHA.
- Projekt bez deterministycznych checks/required checks oraz zmiana pliku spoza
  zatwierdzonego planu są blokowane fail-closed.
