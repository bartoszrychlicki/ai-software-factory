# ai-factory

Lokalna fabryka software z trwałym koordynatorem SQLite. Linear jest kolejką
i interfejsem człowieka, GitHub źródłem prawdy o PR/CI/merge, a Mastra wykonuje
wyłącznie krótkie joby AI: `plan`, `build`, `review`, a w projektach z
deep-planem v3 dodatkowo `triage`, `research`, `synthesis`, `critique`.

```text
Preflight → Plan → /approve → Build → Test/E2E → Draft PR
          → GitHub CI → In Review → Human merge → Prod smoke → Done
```

Projekty z `planPipeline: v3` (deep-plan) mają rozbudowany etap planowania:

```text
Preflight → Triage → [solo: Plan] | [deep: Research ×3 równolegle
          → Synteza (+Rozstrzygnięcia) → Krytyka (max 1 rewizja)] → /approve → …
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

## Konfiguracja per host

`projects.yaml` i `routing.yaml` są wspólne dla wszystkich hostów. Wartości
specyficzne dla maszyny (ścieżki repo, lokalne eksperymenty budżetowe/modelowe)
trzymaj w opcjonalnych, **gitignorowanych** plikach obok bazowych:

- `projects.local.yaml` — nadpisania per projekt,
- `routing.local.yaml` — nadpisania sekcji `defaults` i `projects.<projekt>`
  (inne sekcje najwyższego poziomu są błędem konfiguracji).

Kanał krótkich komentarzy lifecycle ustawia się per projekt przez
`progress: off | milestones | verbose` (także w `projects.local.yaml`).
Domyślne `milestones` raportuje aprobatę, checkpoint, testy, draft PR, CI,
werdykt review i merge; `verbose` dodaje research, krytykę, retry/replan oraz
degradacje. `off` wyłącza tylko komentarze postępu — bramki i finały pozostają.

Semantyka: **płytki merge per projekt/klucz, local wygrywa**. Klucz podany w
`.local` zastępuje klucz bazowy w całości — także obiekty, więc np. lokalny
`budget:` musi być kompletny (`maxUsd` **i** `maxMinutes`). Klucze niewymienione
w `.local` zostają z bazy; projekt obecny tylko w `.local` dochodzi w całości.
Fail-closed: brak pliku `.local` = brak nadpisań, ale plik istniejący
a nieparsowalny albo o złym kształcie zatrzymuje fabrykę twardym błędem — nigdy
nie jest po cichu ignorowany. Walidacje `getProject` (checks, `ci.requiredChecks`)
działają na wyniku merge'a, więc `.local` nie może ich obejść.

Przykład (host produkcyjny nadpisuje ścieżkę repo, budżet i model verify):

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

Zmiany merytoryczne wspólne dla wszystkich hostów commituj do plików bazowych;
`.local` jest wyłącznie na różnice per maszyna. Testy czytają commitowane yaml-e
przez kopię w katalogu tymczasowym, więc lokalne nadpisania hosta nie zmieniają
ich wyniku.

### Plisty launchd bez ścieżek per host

`ops/install-launchd.sh` generuje plisty z szablonów
`ops/com.ai-factory.{server,poller}.plist.template`: npm/node wykrywa
`command -v`, `claude` preferencyjnie z `~/.local/bin/claude`, katalog fabryki
z położenia repo, logi pod `$HOME`. Wykryte katalogi node/npm dochodzą do
`PATH` usług (launchd startuje z minimalnym `PATH` — patrz pułapka BAR-92).
Podgląd wyrenderowanych plistów bez instalacji:

```shell
bash ops/install-launchd.sh --render-only /tmp/ai-factory-plisty
```

## Sterowanie w Linear

Fabryka używa wyłącznie stanów `Todo → In Progress → In Review → Done` oraz
`👤 ⛔ Zablokowany` i `Canceled`. Zmiana fazy przez przeciąganie karty nie jest
decyzją workflow.

- `/approve` — zatwierdza bieżący plan;
- `/reject <powód>` — zatrzymuje plan;
- `/answer <odpowiedź>` — odpowiada na pytania plannera (maks. dwie rundy;
  rundę 1 może zadać triage, rundę 2 synteza);
- `/retry` — ponawia wyłącznie zatrzymany etap;
- `/replan <powód>` — unieważnia plan i tworzy nową generację;
- `/restart` — tymczasowy alias `/replan`;
- `/done` — potwierdza ręczne wykonanie zatwierdzonej checklisty ops;
- `/score 1-5 [komentarz]` — ocena jakości wyniku do danych eksperymentu
  (działa także po Done, do 14 dni).

Labele `plan:solo` / `plan:deep` wymuszają ścieżkę planowania w projektach v3.

Komentarz autora przed buildem zmienia input hash i wymusza nowy plan. Podczas
lub po buildzie zatrzymuje proces, zachowując branch i checkpoint.
Komentarze postępu mają marker fabryki i nie wchodzą do tego input hash.

## Najważniejsze pliki

- `src/pipeline/factory-job.ts` — jedyny krótki workflow Mastry
  (`plan|build|review|triage|research|synthesis|critique`);
- `src/pipeline/coordinator.ts` — czysta maszyna przejść lifecycle;
- `src/pipeline/lifecycle-store.ts` — registry v2, próby i outbox w SQLite;
- `src/metrics/experiments.ts` + `experiment-report.ts` — dane i raport
  eksperymentu wariantów procesu (solo vs deep) i konfiguracji modeli;
- `src/sources/poll-linear-v2.ts` — preflight, dispatch, reconciliation i GitHub;
- `src/pipeline/preflight.ts` — odczytowe sprawdzenie zależności przed claimem;
- `src/pipeline/process-control.ts` — AbortSignal, TERM/KILL grupy procesu;
- `src/pipeline/legacy-migration.ts` — read-only import zatwierdzonego planu,
  checkpointu i jawnie przypiętego PR-a z registry v1;
- `src/pipeline/scope.ts` — warnings dla zwykłych odchyleń i blokada
  sekretów/niezatwierdzonych ścieżek chronionych;
- `projects.yaml` i `routing.yaml` — projekty, checks, budżety i adaptery
  (+ opcjonalne gitignorowane `*.local.yaml` per host — sekcja wyżej).

`ticket-pipeline.ts`, `poll-linear.ts` i `run-registry.ts` pozostają kodem legacy
do odczytu/testów migracji, ale nie są podpięte do runtime.

## Gwarancje

- Build tworzy jeden checkpoint. Brak finału CLI, timeout lub błąd logowania
  zatrzymuje etap bez automatycznego drugiego buildera.
- Testy i E2E biegną bez AI na świeżym checkoutcie dokładnego SHA — w osobnym,
  detached procesie (`test-runner.ts`), więc nie blokują pętli pollera i
  przeżywają jego restart.
- Job wiszący w Mastrze ponad budżet roli + grace kończy się `JOB_STALLED`
  (cancel + `/retry`), nigdy nie wisi w nieskończoność.
- Po FAIL poprawka buildera powstaje wyłącznie po `/retry`.
- `factory.files` jest oczekiwaniem. Dodatkowy zwykły plik daje warning;
  sekret, niezatwierdzony workflow/ops/migracja ORAZ pliki wykonywane przez
  etap test (package.json, lockfile'y, configi testów/buildu, `scripts/`)
  blokują publikację. Per-projekt: `scope.protected` w `projects.yaml`.
- Agent nie dostaje `SSH_AUTH_SOCK`; push/publish robi wyłącznie fabryka.
- PR jest identyfikowany tylko przez trwałe `prUrl`; historyczne komentarze są
  ignorowane. Publish wykrywa istniejący branch/draft PR.
- Każda zmiana PR head SHA unieważnia test/CI i uruchamia scope audit + testy
  nowego SHA, nigdy pełny rebuild.
- Review AI jest advisory i może ponowić wyłącznie review raz. Nigdy nie odpala
  buildera. Reviewer nigdy nie jest tym samym silnikiem co builder
  (`review.diverse` w routing.yaml), a `mark-pr-ready` wychodzi dopiero PO
  werdykcie — komentarz recenzenta istnieje zanim PR opuści draft.
- `Done` dla ticketu kodowego wymaga merge dokładnie śledzonego PR-a. Smoke FAIL
  blokuje już zmergowany ticket bez automatycznego rollbacku.
- Budżet jest wspólny dla wszystkich krótkich jobów ticketu; koszt liczy się
  także dla silników bez raportu (estymata tokenowa codexa albo czasowa —
  `cost_source` w stage_attempts).
- Circuit breaker (seria porażek / koszt na godzinę) wstrzymuje claim nowych
  ticketów; dead-letter outboxu zawsze wysyła powiadomienie; `lifecycle.db`
  ma dzienny backup, a drugi poller na tej samej bazie odmawia startu.
- Dwa tickety z kolizją `planFiles` nie budują równolegle — późniejszy czeka
  (⏸️ komentarz), start automatyczny po domknięciu PR-a trzymającego pliki.
- Deep-plan v3: awaria triage degraduje do ścieżki solo (nigdy nie blokuje);
  pad pojedynczej roli researchu po 1 auto-retry = jawna ⚠️ degradacja na
  bramce; krytyka jest advisory (silnik ≠ synteza) z limitem JEDNEJ rewizji;
  wszystkie degradacje są widoczne w komentarzu `/approve` razem z kosztem.
- Każde Done zapisuje wiersz eksperymentu (`runs/experiments.jsonl`) z
  wariantem procesu, kosztami per etap i sygnaturami modeli z faktycznych
  prób; `/score 1-5` dokleja ocenę człowieka. Raport:
  `npx tsx src/metrics/experiment-report.ts`.
