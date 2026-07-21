# ai-factory — kontekst dla Claude Code (handoff 2026-07-20)

Fabryka software: ticket → intake → plan (+gate niejasności) → human gate → pętla build→verify (max 2 próby, feedback) → assert → publish (draft PR) → pętla review→fix (max 3 rundy: recenzja z werdyktem `REVIEW: LGTM/FIX`, builder poprawia, checks pilnują regresji, push aktualizuje PR) → finalize (LGTM → `gh pr ready`, draft zdjęty; uwagi/skip → zostaje draft z ⚠️). Verify robi też screenshot podglądu (projekty z `screenshot:` w projects.yaml), który poller wrzuca do ticketa w Linear. Orkiestracja: Mastra 1.19 (workflow `ticket-pipeline`). Agenci to **zewnętrzne CLI w trybie headless na subskrypcjach** (Claude Code, Codex), wołane przez wspólny kontrakt `EngineAdapter` — Mastra sama NIE wykonuje żadnych wywołań modeli. Pełny plan i decyzje: `../docs/ai-software-factory-plan-v2.md`.

## Mapa kodu

- `src/engines/types.ts` — kontrakt `EngineAdapter.run({role, instructions, context, workspace, budget, model?}) → {ok, report, costUsd?, raw}`. **Adapter nigdy nie rzuca** — błąd = `ok:false`; decyzje podejmują kroki pipeline'u.
- `src/engines/claude-code.ts` — `claude -p --output-format json`; role ≠ build dostają tylko `Read,Glob,Grep`.
- `src/engines/codex.ts` — `codex exec`, sandbox `read-only`/`workspace-write` wg roli; **musi mieć `child.stdin.end()`**.
- `src/engines/kimi-code.ts` — `kimi -p` (headless). **TYLKO rola build**: tryb -p zawsze auto-zatwierdza zapisy i nie ma read-only (`--plan`/`--yolo`/`--auto` nie łączą się z `-p`) — inne role dostają odmowę fail-closed. Label `engine:*` działa przez to wyłącznie na build (routing.ts). Bez raportu kosztów.
- `src/engines/index.ts` — rejestr silników (nowy silnik = adapter + wpis + linijka w routing.yaml).
- `src/sources/types.ts` — kontrakt `TicketSource`.
- `src/sources/linear.ts` — `LinearSource` (GraphQL API; klucz w `.env` jako `LINEAR_API_KEY`, projekt `LINEAR_PROJECT`). Nazwa projektu w Linear == klucz w projects.yaml.
- `src/sources/poll-linear.ts` — poller: co 60 s bierze issues z labelem `agent:ready` (stan backlog/todo), claimuje (zdejmuje label + In Progress), startuje run przez API Mastry i raportuje komentarzami. **Aprobata planu w Linear**: komentarz `zatwierdzam` / `odrzuć: powód` pod planem (nowszy niż komentarz z planem, bez markera fabryki; polling co 20 s → resume-async); Studio działa równolegle jako fallback. Przy sukcesie uploaduje screenshot do CDN Lineara i osadza w komentarzu. Multi-projekt: `LINEAR_PROJECTS=pilot-app,br-budget` w .env (nazwa projektu w Linear == klucz projects.yaml). Produkcyjnie działa jako usługa launchd; ręcznie: `npx tsx src/sources/poll-linear.ts [--once]`.
- `src/pipeline/ticket-pipeline.ts` — cały workflow, w tym pętla `dountil` na `build-verify-cycle`.
- `src/pipeline/workspace.ts` — worktree per ticket w `~/.ai-factory/worktrees/<repo>/<ticket>`; `createCheckout` = świeży detached checkout SHA dla verify.
- `src/pipeline/projects.ts` — rejestr projektów (`projects.yaml`); `findUpFile` szuka configów w górę drzewa (mastra dev ma cwd w `src/mastra/public`!).
- `src/pipeline/routing.ts` — `resolveRoute(etap, ticket, domena?)`; kolejność: label `engine:*` > `projects.<p>.<etap[.domena]>` > `defaults.<etap.domena>` > `defaults.<etap>`; spec = `silnik[/model]`.
- `routing.yaml`, `projects.yaml` — konfiguracja (checks weryfikacyjne są per projekt w projects.yaml).
- Projekty fabryki: pilot-app (`~/Development/Edu/ai-sdlc/pilot-app`, publiczny, main chroniony) i **br-budget** (`~/Development/Clients/Bartosz/br-budget`, Next.js, PRYWATNY — bez branch protection na free planie, checks: ci+lint+build+test, bez screenshotu bo next wymaga env/bazy).
- Repo pilotowe: `~/Development/Edu/ai-sdlc/pilot-app` (przeniesione do wnętrza ai-sdlc, w `.gitignore`; GitHub `bartoszrychlicki/pilot-app`, `main` chroniony: wymagany PR, enforce_admins, bez force-push).

## Komendy

- Typecheck: `npx tsc --noEmit` — **obowiązkowo po każdej zmianie** (mastra dev/tsx nie sprawdzają typów).
- **Produkcyjnie: usługi launchd** (`com.ai-factory.server` = mastra dev, `com.ai-factory.poller`): instalacja/reload `bash ops/install-launchd.sh`; logi `~/.ai-factory/logs/`; stop `launchctl bootout gui/501/com.ai-factory.<server|poller>`. Auto-start przy logowaniu, auto-restart po padzie. UWAGA: ręczny `mastra dev` gryzie się z usługą (port + lock DuckDB) — najpierw bootout.
- Dev ręcznie (gdy usługa zatrzymana): `FACTORY_ROOT=$(pwd) CLAUDE_BIN=~/.local/bin/claude npm run dev` → Studio `localhost:4111`.
- Run bez Studio: API Mastry (`localhost:4111/api`, endpointy create-run/start/resume — lista w Studio → API endpoints). Human gate `approve-plan` wymaga resume z `{"approved": true}`.
- Smoke adapterów: `CLAUDE_BIN=~/.local/bin/claude npx tsx src/engines/smoke.ts`.
- Raport metryk: `npx tsx src/metrics/report.ts` (czyta `runs/metrics.jsonl` — wiersz per wywołanie silnika, zapisywany przez `src/pipeline/metrics.ts`; koszt/czas/first-pass rate per etap×silnik).

## Pułapki (opłacone tokenami — nie odkrywać ponownie)

- `codex exec` czeka na stdin (pipe) → zawsze `child.stdin.end()`.
- Checks w verify: **czyste env** (odfiltrowane `npm_config_*` i `NODE_ENV` — dziedziczone po `npm run dev` przestawiają `npm ci` na production = brak devDeps) i `bash -c`, NIE `-lc` (path_helper macOS przestawia PATH).
- `git worktree prune` przed tworzeniem checkoutu (martwe rejestracje po skasowanych katalogach).
- Zmiana pliku źródłowego w trakcie runa = rebundle + restart serwera = **ubity run**. Nie edytować, gdy pipeline leci.
- Jeden `mastra dev` naraz (lock DuckDB); Studio na porcie ≠ 4111 = gdzieś wisi duplikat.
- `claude` na tej maszynie przez pełną ścieżkę `~/.local/bin/claude` (funkcja shellowa cmux przechwytuje gołą komendę).
- `total_cost_usd` z claude to ekwiwalent API — na subskrypcji realnie zjada limity (okna 5h/tygodniowe), nie pieniądze.
- Git przez sandbox Cowork zostawia martwe locki (`index.lock`, `HEAD.lock`) w `ai-sdlc/.git` — sprawdzić `pgrep -fl git` i skasować.
- Node przy `spawn` z nieistniejącym `cwd` zgłasza **mylące `ENOENT` na binarce** — jeśli adapter mówi „claude ENOENT", najpierw sprawdź, czy katalog roboczy (repoPath z projects.yaml!) istnieje.
- **launchd ma minimalny PATH** — każde CLI wołane przez fabrykę (gh! kimi, codex, claude) musi być w `EnvironmentVariables.PATH` w plistach ops/. Objaw: `spawn gh ENOENT` w publish (BAR-92) mimo verify PASS.
- Budżety kroków kalibrować pod najwolniejszy model: plan 5 min ubił Fable@high na produkcyjnym repo (BAR-91, kill w 301 s) → podniesiony do 12 min.
- Routing `build.frontend` działa TYLKO z labelem `domain:frontend` na tickecie — bez labela idzie default build (BAR-92 poszedł w codex zamiast Opusa).
- **Prompt do CLI przez argv ma limit (~1 MB): spawn E2BIG** — feedback z nieudanej próby zawierał echo komendy z całym promptem i rozdął prompt próby 2 (BAR-91). Codex dostaje prompt przez STDIN (`-`), feedback jest clipowany, raporty błędów bez error.message (echo komendy).
- **Kalibracja pod premium modele (fable/opus/sol@xhigh)**: budżety kroków plan 12 min / build 25 min; budżet ticketu br-budget $8/60min (plan ~$1-2.3 + build ~$1.7+); pełny cykl ~$5-6 ekwiwalentu — godzinowy limit breakera $10/h łatwo przebić przy retry (nocna zmiana 2026-07-21 przebiła po 5 runach).
- Nieudany/przerwany run zostawia w repo pilotowym gałąź `agent/<ticket>-…` i worktree'y — kolejny run tego samego ticketu pada na `branch already exists`. Sprzątanie: `git worktree prune`, `rm -rf` martwego katalogu verify, `git branch -D`. (Docelowo: idempotentne workspace.ts — patrz backlog.)

## Stan na 2026-07-21 rano (po nocnej zmianie)

**br-budget w pełni operacyjny na premium modelach.** Nocna zmiana (opiekun: Claude, delegacja Bartosza na aprobaty planów): BAR-92 → [PR #75](https://github.com/bartoszrychlicki/br-budget/pull/75) (glass pills w headerze landingu; Opus builder, verify odrzucił próbę 1, LGTM runda 1), BAR-91 → [PR #76](https://github.com/bartoszrychlicki/br-budget/pull/76) (model wniosków „co się zmieniło" + analiza prod z Fazy 0; Sol builder ~18 min/próba, 2 próby verify, 1 runda fix, LGTM; $6.91 w budżecie $8). Oba ready for review — **czekają na merge Bartosza** razem z PR #4–#8 pilot-app. Koszt nocy ~$15 ekwiwalentu; wszystkie 4 porażki po drodze = kalibracja infry pod premium modele (budżety, PATH, E2BIG), wnioski w Pułapkach. Bezpiecznik godzinowy $10/h zadziałał raz — poprawnie.

## Stan wcześniejszy (koniec sesji 2026-07-20)

**Fabryka jest funkcjonalnie kompletna dla pilota — cały uzgodniony backlog #1–#6 zrealizowany i zweryfikowany E2E na żywych ticketach.** Jedyny brak do trybu bezobsługowego: poller i `mastra dev` to ręcznie odpalane procesy (patrz backlog: operacjonalizacja).

Co działa (wszystko potwierdzone runami):

- **Pełny cykl Linear→Done-bez-Done**: label `agent:ready` → claim → plan (gate niejasności: `PLAN: OK/BLOCKED`, spełniony-w-kodzie też blokuje) → **aprobata komentarzem w Linear** (`zatwierdzam`/`odrzuć: powód`) → build→verify (max 2, świeży checkout + checks) → screenshot → draft PR → **pętla review→fix (max 3 rundy, `REVIEW: LGTM/FIX`)** → LGTM = `gh pr ready` / uwagi = zostaje draft z ⚠️ → komentarz wyniku ze screenshotem w Linear, ticket „In Review". Merge ludzki; po merge'u ticket NIE przechodzi sam na Done (luka → backlog).
- **Multi-engine**: claude-code (plan/verify/review), codex (build default), **kimi-code (build-only!)** przez label `domain:frontend` → `build.frontend`. Kimi nie ma read-only w headless — adapter odmawia ról ≠ build, label `engine:*` działa tylko na build.
- **Artefakty** `runs/<ticket>/<runId>/` (plan, approval, build/verify/fix/review per próba/runda, screenshot, result) + **metryki** `runs/metrics.jsonl` (raport: `npx tsx src/metrics/report.ts`).
- Zrealizowane tickety: TEST-2/3/4 (PR #1–#3, zmergowane), BAR-95 welcome screen (PR #4), BAR-96 © w stopce (PR #5), BAR-98 polska etykieta licznika (PR #6), BAR-99 lang=pl+meta — **pierwszy build Kimi i pierwsza iteracja review→fix** (PR #7, ready). BAR-97 = poprawny BLOCKED (ticket już spełniony; builder próbował pozorować zmianę, verify zabił). PR #4–#6 draft (stara recenzja bez werdyktu), #7 ready — wszystkie czekają na merge Bartosza.
- Znane słabości: raport `claude -p` = ostatnia wiadomość agenta (meta-komentarz po planie gubi marker → fail-closed BLOCKED, ale raport nieczytelny); 504 po 180 s na start/resume-async (run leci dalej — czytać stan pollingiem); sierocony run po restarcie pollera traci opiekuna (nikt nie skomentuje wyniku).

## Backlog (kolejność uzgodniona z Bartoszem)

1. ~~Operacjonalizacja~~ ✓ zrobione 2026-07-20: usługi launchd (ops/), merge-watcher (PR MERGED → Done + sprzątanie worktree/gałęzi + ff-pull lokalnego main; PR CLOSED → Todo z komentarzem), adopcja sierot na starcie pollera (runId z komentarza z planem), health-check API przed claimem. Poller w `--once` nadal działa do testów.
2. ~~Budżety + circuit breaker~~ ✓ zrobione 2026-07-20: budżet per ticket-run (`src/pipeline/budget.ts`, liczony z metrics.jsonl; defaulty 45 min / $3 przez `FACTORY_BUDGET_MAX_MIN`/`_USD`, per projekt `budget:` w projects.yaml; build/verify → BLOCKED, review/fix → degradacja bez wywalania runu). Circuit breaker (`src/pipeline/breaker.ts`, stan `runs/circuit-breaker.json`): 3 porażki z rzędu (`FACTORY_CB_BLOCKED_STREAK`) albo >$10/h (`FACTORY_CB_USD_PER_H`) → poller nie podejmuje NOWYCH ticketów (labele zostają; merge-watcher i adopcja działają dalej); cooldown 360 min (`FACTORY_CB_COOLDOWN_MIN`, half-open), reset ręczny = usuń plik stanu; odrzucenie planu przez człowieka nie nabija serii.
3. **Dual-plan z fuzją** (zaprojektowany, wchodzi przy pierwszych grubszych ticketach): dwa NIEZALEŻNE plany RÓŻNYMI silnikami (`.parallel()`; ten sam model 2× = skorelowane ślepe plamy) → arbiter „fusion" (read-only) jawnie wyszukuje rozbieżności, skleja JEDEN plan z sekcją „Rozstrzygnięcia"; spór nierozstrzygalny = `PLAN: BLOCKED` z opcjami A/B dla człowieka. Per ticket labelem `plan:duo`. Routing `plan.a`/`plan.b`/`plan.fusion`. Artefakty `plan-a.md`/`plan-b.md`/`plan.md`. Debata iteracyjna odrzucona (malejące zyski). Metryki rozstrzygną: czy `plan:duo` daje mniej FAIL-i w verify i mniej rund review→fix.
4. **Dekompozycja fullstack** (plan v2 §4, poziom 1): planner dzieli plan na subtaski z kontraktem, fabryka wykonuje sekwencyjnie w jednym worktree różnymi silnikami (`build.backend`/`build.frontend`), jeden PR, jeden verify. Czeka na projekt z prawdziwym backendem — pilot-app jest czysto frontendowy.
5. **Izolacja profili CLI** — ŚWIADOMIE ODŁOŻONE (decyzja Bartosza 2026-07-20): na tym etapie agenci MAJĄ mieć dostęp do jego skilli i serwerów MCP. Nie wdrażać bez jego wyraźnej zgody.
6. ~~Powiadomienia~~ ✓ zrobione 2026-07-21 (`notify.ts`: macOS notification center aktywny; Telegram włączy się automatycznie po dodaniu `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` do .env — czeka na token od Bartosza). Zdarzenia: plan do akceptacji ⏳, BLOCKED/failed 🛑, PR ready ✅, breaker 🔌, prod smoke FAIL 🚨.
7. **Proces i kontrakt planowania** (decyzja 2026-07-21): wypracować konkretny, ustrukturyzowany prompt plannera + zdefiniowany format outputu planu (stałe sekcje, kontrakt z builderem/verify/gate'ami) — projektować RAZEM z dual-plan mode, bo plany dwóch silników muszą być porównywalne i skladalne przez arbitra. Dziś prompt to ~10 luźnych linijek w planStep; Fable wyciąga z nich dużo, ale to zasługa modelu, nie procesu. Case'y do uwzględnienia: tickety analityczne (BAR-91 — „sprawdź na danych produkcyjnych", planner jest read-only na kodzie!) vs implementacyjne.
8. **Prompt caching / optymalizacja tokenów per projekt** (idea Bartosza 2026-07-21, eksploracja): agent nie powinien co run mielić od zera tego samego codebase'u. Kierunki: reużycie sesji CLI per projekt (claude --session/-c, codex resume, kimi -S — caching Anthropic działa w sesji); „context pack" per projekt (predigestowane streszczenie architektury odświeżane po merge'ach, doklejane do promptów zamiast zimnej eksploracji); higiena CLAUDE.md/AGENTS.md w repo docelowych (br-budget ma — planner cytował „lekcję z BAR-85"); pomiar metrykami przed/po.
9. **Dwie rundy QA**: ~~runda 2 (prod smoke po merge)~~ ✓ zrobione 2026-07-21 (`prod-smoke.ts` + `prodSmokeGuard` w pollerze: po merge'u 90 s na deploy + 4 retry co 60 s; checki deklaratywne `qa.prodChecks` w projects.yaml — status/textIncludes/headerIncludes; FAIL → ticket wraca do In Review + 🚨 komentarz + powiadomienie; br-budget: checki na `x-vercel-id` FAILują do cutovera BAR-77/102 — celowo). ~~Runda 1 (e2e w verify)~~ ✓ zrobione 2026-07-21: `qa.e2e` w projects.yaml (br-budget: `E2E_BROWSER_CHANNEL=bundled npm run e2e:local` — 50 testów ~2 min, plikowa SQLite, zero sekretów, dry-run na świeżym checkoutcie przeszedł); verify odpala po tanich checks (fail fast), FAIL = verdict fail z ogonem Playwrighta jako feedbackiem, metryka `verify-e2e`. CAŁY backlog #9 domknięty. 
10. **Statusy Linear odwzorowujące proces + aprobata przez status** (decyzja Bartosza 2026-07-21): stany per team (Planowanie/Plan do akceptacji/Build/Weryfikacja/Code review/PR ready/Wymaga decyzji) pisane WYŁĄCZNIE przez fabrykę; aprobata planu = przeciągnięcie karty Plan do akceptacji → Build (polling stanu obok komentarzy); odrzucenie ZOSTAJE komentarzem (niesie powód). Uwaga na wyścig z integracją Linear↔GitHub.
11. **Runda refinementu ticketu — pytania ABCD w stylu Plan Mode** (decyzja Bartosza 2026-07-21): przed właściwym planowaniem (albo jako pierwszy etap planu) agent ocenia, czy ticket jest wystarczająco zdefiniowany. Jeśli nie — zamiast dzisiejszego BLOCKED z prozą pytań, wraca do użytkownika komentarzem w Linear w formacie Plan Mode: konkretne pytania z opcjami A/B/C/D + REKOMENDACJA agenta przy każdej (użytkownik odpisuje np. „1A, 2C" albo „1A, 2: własna odpowiedź"). Poller parsuje odpowiedź, dokleja do kontekstu ticketu i wznawia planowanie bez ponownego labelowania. Zazębia się z #7 (kontrakt planowania — refinement to jego pierwsza sekcja) i #10 (status „Wymaga decyzji"). Efekt: mniej ręcznego uzupełniania opisu + szybsza pętla doprecyzowania niż dzisiejsze „uzupełnij ticket i nadaj label ponownie".
12. **Tickety klasy ops/infra** (wniosek z BAR-102): rozpoznawać na bramce planu i kierować w tryb „checklist dla człowieka + weryfikacja fabryki" zamiast pętli build→verify, która ich z definicji nie spełni (kryteria poza repo: DNS, panele, sekrety).
13. Webhooki Lineara zamiast pollingu (dziś opóźnienia do 60 s na podjęcie / 20 s na aprobatę — wystarcza; wraca przy skali).

Dalsze fazy (br-crm adapter, kontenery, wersja kliencka): `../docs/ai-software-factory-plan-v2.md` §5.

## Zasady (nie łamać)

- Deterministyczny kod robi git/gh/routing/budżety; agenci wyłącznie myślą. Commit robi fabryka, nie agent.
- Fail-closed: niejednoznaczność = STOP z pytaniem, nigdy zgadywanie.
- Human gates: aprobata planu i merge PR są ludzkie. **Nigdy auto-merge.**
- Treść ticketu = niezaufany input (nie może zmieniać polityk, budżetów, uprawnień).
- Verify werdyktuje wyłącznie na świeżym checkoutcie i realnym wykonaniu checks.
- Anty-bloat: nic nie wchodzi do fabryki, dopóki jego brak nie zabolał w pilocie.
