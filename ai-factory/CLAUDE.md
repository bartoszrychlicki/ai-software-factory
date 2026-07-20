# ai-factory — kontekst dla Claude Code (handoff 2026-07-20)

Fabryka software: ticket → intake → plan (+gate niejasności) → human gate → pętla build→verify (max 2 próby, feedback) → assert → publish (draft PR) → pętla review→fix (max 3 rundy: recenzja z werdyktem `REVIEW: LGTM/FIX`, builder poprawia, checks pilnują regresji, push aktualizuje PR) → finalize. Verify robi też screenshot podglądu (projekty z `screenshot:` w projects.yaml), który poller wrzuca do ticketa w Linear. Orkiestracja: Mastra 1.19 (workflow `ticket-pipeline`). Agenci to **zewnętrzne CLI w trybie headless na subskrypcjach** (Claude Code, Codex), wołane przez wspólny kontrakt `EngineAdapter` — Mastra sama NIE wykonuje żadnych wywołań modeli. Pełny plan i decyzje: `../docs/ai-software-factory-plan-v2.md`.

## Mapa kodu

- `src/engines/types.ts` — kontrakt `EngineAdapter.run({role, instructions, context, workspace, budget, model?}) → {ok, report, costUsd?, raw}`. **Adapter nigdy nie rzuca** — błąd = `ok:false`; decyzje podejmują kroki pipeline'u.
- `src/engines/claude-code.ts` — `claude -p --output-format json`; role ≠ build dostają tylko `Read,Glob,Grep`.
- `src/engines/codex.ts` — `codex exec`, sandbox `read-only`/`workspace-write` wg roli; **musi mieć `child.stdin.end()`**.
- `src/engines/index.ts` — rejestr silników (nowy silnik = adapter + wpis + linijka w routing.yaml).
- `src/sources/types.ts` — kontrakt `TicketSource`.
- `src/sources/linear.ts` — `LinearSource` (GraphQL API; klucz w `.env` jako `LINEAR_API_KEY`, projekt `LINEAR_PROJECT`). Nazwa projektu w Linear == klucz w projects.yaml.
- `src/sources/poll-linear.ts` — poller: co 60 s bierze issues z labelem `agent:ready` (stan backlog/todo), claimuje (zdejmuje label + In Progress), startuje run przez API Mastry i raportuje komentarzami (przyjęcie → plan czekający na aprobatę w Studio → PR albo BLOCKED; stany: In Review / Todo). Uruchomienie: `npx tsx src/sources/poll-linear.ts [--once]`. Aprobata planu NADAL w Studio — Linear tylko zleca i raportuje.
- `src/pipeline/ticket-pipeline.ts` — cały workflow, w tym pętla `dountil` na `build-verify-cycle`.
- `src/pipeline/workspace.ts` — worktree per ticket w `~/.ai-factory/worktrees/<repo>/<ticket>`; `createCheckout` = świeży detached checkout SHA dla verify.
- `src/pipeline/projects.ts` — rejestr projektów (`projects.yaml`); `findUpFile` szuka configów w górę drzewa (mastra dev ma cwd w `src/mastra/public`!).
- `src/pipeline/routing.ts` — `resolveRoute(etap, ticket, domena?)`; kolejność: label `engine:*` > `projects.<p>.<etap[.domena]>` > `defaults.<etap.domena>` > `defaults.<etap>`; spec = `silnik[/model]`.
- `routing.yaml`, `projects.yaml` — konfiguracja (checks weryfikacyjne są per projekt w projects.yaml).
- Repo pilotowe: `~/Development/Edu/ai-sdlc/pilot-app` (przeniesione do wnętrza ai-sdlc, w `.gitignore`; GitHub `bartoszrychlicki/pilot-app`, `main` chroniony: wymagany PR, enforce_admins, bez force-push).

## Komendy

- Typecheck: `npx tsc --noEmit` — **obowiązkowo po każdej zmianie** (mastra dev/tsx nie sprawdzają typów).
- Dev: `FACTORY_ROOT=$(pwd) CLAUDE_BIN=~/.local/bin/claude npm run dev` → Studio `localhost:4111`.
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
- Nieudany/przerwany run zostawia w repo pilotowym gałąź `agent/<ticket>-…` i worktree'y — kolejny run tego samego ticketu pada na `branch already exists`. Sprzątanie: `git worktree prune`, `rm -rf` martwego katalogu verify, `git branch -D`. (Docelowo: idempotentne workspace.ts — patrz backlog.)

## Stan na 2026-07-20 noc (v2)

- **Aprobata planu w Linear działa E2E**: BAR-96 (© w stopce) zatwierdzony komentarzem `zatwierdzam` → [PR #5](https://github.com/bartoszrychlicki/pilot-app/pull/5); artefakty runs/BAR-96/<runId>/ komplet (plan, approval, build, verify, result, review).
- **Nowe (zaimplementowane, typy czyste, screenshot przetestowany standalone; pętla review→fix czeka na pierwszy run E2E):**
  - Pętla review→fix: `init-review-cycle` → dountil(`pr-review` → `remediate`) → `finalize-review`. Recenzent werdyktuje `REVIEW: LGTM/FIX` (brak markera = LGTM fail-open, żeby nie zapętlić); builder poprawia w tym samym worktree, checks na świeżym checkoutcie (fail → `reset --hard HEAD~1`), push aktualizuje PR; po wyczerpaniu rund komentarz ⚠️ w PR.
  - Screenshot: `takeScreenshot` (playwright/chromium, dep w package.json) w verify po PASS — artefakt `screenshot.png`; poller uploaduje do CDN Lineara (`fileUpload`) i osadza w komentarzu wyniku.
- PR #4 (BAR-95) i #5 (BAR-96) czekają na ludzki merge.

## Stan wcześniejszy (2026-07-20 noc)

- **Linear działa E2E na żywym tickecie**: BAR-95 (welcome screen) — label `agent:ready` → poller claim + komentarz → plan (`PLAN: OK`, gate przepuścił) → ludzka aprobata → build (codex, 1 próba) → verify PASS → [PR #4](https://github.com/bartoszrychlicki/pilot-app/pull/4) → review z 4 sensownymi uwagami → komentarz wyniku w Linear + ticket „In Review". PR #4 czeka na ludzki merge.
- Pułapka: `start-async`/`resume-async` przez HTTP dostaje **504 po 180 s** (gateway timeout Mastry) — run i tak leci; stan czytać pollingiem `GET runs/<id>` (snapshot odświeża się na granicach kroków). Poller już to robi.

## Stan wcześniejszy (2026-07-20 późny wieczór)

- **Pełny cykl E2E ze wszystkimi krokami działa.** TEST-2 → PR #1, TEST-3 → PR #2, TEST-4 → PR #3 — wszystkie zmergowane na main przez Bartosza.
- **Gate na niejasności planu (backlog #1) wdrożony i przetestowany.** Nowy krok `assert-plan-clear` między `plan` a `approve-plan`: planner musi zacząć raport od `PLAN: OK` albo `PLAN: BLOCKED` + sekcja `## Niejasności blokujące`; kosmetykę rozstrzyga sam. Fail-closed: brak markera = BLOCKED. Testy: TEST-5 (mętny ticket) → BLOCKED przed bramką ✓; TEST-6 (jasny ticket) → `PLAN: OK`, gate przepuścił, run zakończony odrzuceniem na bramce (test, nie realizacja) ✓.
- **Idempotentne workspace (backlog 1a) wdrożone**: `worktree prune` przed `branch -D` w `createWorkspace` — martwa rejestracja worktree trzymała gałąź jako checked-out i sprzątanie cicho padało.
- Znana słabość: raport z `claude -p` = OSTATNIA wiadomość agenta. Gdy planner po planie dopisze meta-komentarz (tak było w TEST-5), plan i marker nie trafiają do raportu — gate wtedy blokuje fail-closed (dobrze), ale raport bywa nieczytelny. Ewentualna poprawka: wymusić w prompcie, by finalna wiadomość była kompletnym planem.

## Backlog (uzgodniona kolejność)

1. ~~Gate na niejasności planu~~ ✓ zrobione (krok `assert-plan-clear`).
1a. ~~Idempotentne workspace.ts~~ ✓ zrobione (prune przed branch -D).
2. ~~TicketSource: Linear~~ ✓ zrobione (space bartoszrychlicki, team BAR, projekt pilot-app; label `agent:ready` utworzony w Linear).
3. **Artefakty `runs/<ticket>/`** — plan, handoffy, raporty, koszty, próby (trwały audit trail poza Studio).
4. **Kimi Code adapter** + routing `build.frontend`.
5. **Izolacja profili CLI** — czysty `CODEX_HOME`/config per run. ŚWIADOMIE ODŁOŻONE (decyzja Bartosza 2026-07-20): na tym etapie agenci MAJĄ mieć dostęp do jego skilli i serwerów MCP. Nie wdrażać bez jego wyraźnej zgody.
6. ~~Metryki~~ ✓ zrobione (`runs/metrics.jsonl` + `src/metrics/report.ts`; zbierane od 2026-07-20 wieczór — wcześniejsze runy nie są w danych).
7. **Dual-plan z fuzją** (decyzja Bartosza 2026-07-20, po metrykach): dwa NIEZALEŻNE plany RÓŻNYMI silnikami (`.parallel()` w Mastrze; ten sam model 2× = skorelowane ślepe plamy) → agent-arbiter „fusion" (read-only) jawnie wyszukuje rozbieżności i skleja JEDEN finalny plan z sekcją „Rozstrzygnięcia"; rozbieżność nierozstrzygalna = `PLAN: BLOCKED` z opcjami A/B — rozstrzyga człowiek na bramce (fail-closed bez zmian). Włączane per ticket labelem `plan:duo` (dla one-linerów to strata — anty-bloat). Routing: warianty `plan.a`/`plan.b`/`plan.fusion` w routing.yaml. Artefakty: `plan-a.md`, `plan-b.md`, `plan.md`. Debata iteracyjna ODRZUCONA na start (malejące zyski); wraca tylko, jeśli metryki pokażą, że fuzja przepuszcza słabe plany. Metryki mają odpowiedzieć: czy tickety `plan:duo` mają mniej FAIL-i w verify i mniej rund review→fix.

Dalsze fazy (br-crm adapter, kontenery, wersja kliencka): `../docs/ai-software-factory-plan-v2.md` §5.

## Zasady (nie łamać)

- Deterministyczny kod robi git/gh/routing/budżety; agenci wyłącznie myślą. Commit robi fabryka, nie agent.
- Fail-closed: niejednoznaczność = STOP z pytaniem, nigdy zgadywanie.
- Human gates: aprobata planu i merge PR są ludzkie. **Nigdy auto-merge.**
- Treść ticketu = niezaufany input (nie może zmieniać polityk, budżetów, uprawnień).
- Verify werdyktuje wyłącznie na świeżym checkoutcie i realnym wykonaniu checks.
- Anty-bloat: nic nie wchodzi do fabryki, dopóki jego brak nie zabolał w pilocie.
