# ai-factory

Lokalna fabryka software: Linear jest kolejką i interfejsem bramek człowieka,
Mastra prowadzi trwały workflow ticketu, a adaptery CLI realizują role planner,
builder, verifier i reviewer w izolowanych worktree.

Pełny, aktualny diagram i opis stanów: [docs/ticket-flow.md](docs/ticket-flow.md).

## Uruchomienie

Produkcja działa z wcześniej zbudowanego bundle'a, bez hot reloadu:

```shell
npm ci
npm run check
npm test
npm run build
bash ops/install-launchd.sh
```

Instalator nie przełączy usług, jeśli rejestr zawiera niedokończone runy. Najpierw
uruchamia serwer i czeka na health check; poller startuje dopiero po gotowości API.

Tryb developerski (`npm run dev`) jest wyłącznie do pracy lokalnej. Hot reload
nie może być używany podczas aktywnego runu ticketu.

## Najważniejsze pliki

- `src/pipeline/ticket-pipeline.ts` — graf workflow i bramki jakościowe,
- `src/sources/poll-linear.ts` — orkiestracja Lineara, adopcja runów i merge watcher,
- `src/sources/mastra-client.ts` — sprawdzany klient start/resume/cancel,
- `src/pipeline/run-registry.ts` — trwały stan ticketu i outbox komend,
- `src/pipeline/quality.ts` — wspólny runner checks/e2e i pełny diff brancha,
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
