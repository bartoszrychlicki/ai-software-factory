# ai-factory

Lokalna fabryka software z trwałym koordynatorem SQLite. Linear jest kolejką
i interfejsem człowieka, GitHub źródłem prawdy o PR/CI/merge, a Mastra wykonuje
wyłącznie krótkie joby AI: `plan`, `build`, `review`.

```text
Preflight → Plan → /approve → Build → Test/E2E → Draft PR
          → GitHub CI → In Review → Human merge → Prod smoke → Done
```

Żaden workflow Mastry nie czeka na człowieka, CI ani merge i nie jest wznawiany.
Poller może zostać zrestartowany w dowolnym etapie; kanoniczny stan, próby i
idempotentny outbox są w `runs/lifecycle.db`.

Pełny diagram: [docs/ticket-flow.md](docs/ticket-flow.md).
Decyzja architektoniczna BAR-157:
[docs/mastra-lifecycle-spike.md](docs/mastra-lifecycle-spike.md).

## Uruchomienie i walidacja

```shell
npm ci
npm run check
npm test
npm run build
```

Poller developerski:

```shell
FACTORY_ROOT="$(pwd)" npm run poller -- --once
```

Produkcja nadal korzysta z instalatora `ops/install-launchd.sh`. Nie buduj bundle'a
pod działającym serwerem i nie uruchamiaj drugiej Mastry na tym samym storage.

## Sterowanie w Linear

Fabryka używa wyłącznie stanów `Todo → In Progress → In Review → Done` oraz
`👤 ⛔ Zablokowany` i `Canceled`. Zmiana fazy przez przeciąganie karty nie jest
decyzją workflow.

- `/approve` — zatwierdza bieżący plan;
- `/reject <powód>` — zatrzymuje plan;
- `/answer <odpowiedź>` — odpowiada na pytania plannera (maks. dwie rundy);
- `/retry` — ponawia wyłącznie zatrzymany etap;
- `/replan <powód>` — unieważnia plan i tworzy nową generację;
- `/restart` — tymczasowy alias `/replan`;
- `/done` — potwierdza ręczne wykonanie zatwierdzonej checklisty ops.

Komentarz autora przed buildem zmienia input hash i wymusza nowy plan. Podczas
lub po buildzie zatrzymuje proces, zachowując branch i checkpoint.

## Najważniejsze pliki

- `src/pipeline/factory-job.ts` — jedyny krótki workflow Mastry;
- `src/pipeline/coordinator.ts` — czysta maszyna przejść lifecycle;
- `src/pipeline/lifecycle-store.ts` — registry v2, próby i outbox w SQLite;
- `src/sources/poll-linear-v2.ts` — preflight, dispatch, reconciliation i GitHub;
- `src/pipeline/preflight.ts` — odczytowe sprawdzenie zależności przed claimem;
- `src/pipeline/process-control.ts` — AbortSignal, TERM/KILL grupy procesu;
- `src/pipeline/legacy-migration.ts` — read-only import zatwierdzonego planu,
  checkpointu i jawnie przypiętego PR-a z registry v1;
- `src/pipeline/scope.ts` — warnings dla zwykłych odchyleń i blokada
  sekretów/niezatwierdzonych ścieżek chronionych;
- `projects.yaml` i `routing.yaml` — projekty, checks, budżety i adaptery.

`ticket-pipeline.ts`, `poll-linear.ts` i `run-registry.ts` pozostają kodem legacy
do odczytu/testów migracji, ale nie są podpięte do runtime.

## Gwarancje

- Build tworzy jeden checkpoint. Brak finału CLI, timeout lub błąd logowania
  zatrzymuje etap bez automatycznego drugiego buildera.
- Testy i E2E biegną bez AI na świeżym checkoutcie dokładnego SHA.
- Po FAIL poprawka buildera powstaje wyłącznie po `/retry`.
- `factory.files` jest oczekiwaniem. Dodatkowy zwykły plik daje warning;
  sekret lub niezatwierdzony workflow/ops/migracja blokują publikację.
- PR jest identyfikowany tylko przez trwałe `prUrl`; historyczne komentarze są
  ignorowane. Publish wykrywa istniejący branch/draft PR.
- Każda zmiana PR head SHA unieważnia test/CI i uruchamia scope audit + testy
  nowego SHA, nigdy pełny rebuild.
- Review AI jest advisory i może ponowić wyłącznie review raz. Nigdy nie odpala
  buildera.
- `Done` dla ticketu kodowego wymaga merge dokładnie śledzonego PR-a. Smoke FAIL
  blokuje już zmergowany ticket bez automatycznego rollbacku.
- Budżet jest wspólny dla wszystkich krótkich jobów ticketu.
