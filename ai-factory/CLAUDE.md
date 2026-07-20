# ai-factory — kontekst dla Claude Code (handoff 2026-07-20)

Fabryka software: ticket → intake → plan → human gate → pętla build→verify (max 2 próby, feedback) → assert → publish (draft PR) → review (doradcze). Orkiestracja: Mastra 1.19 (workflow `ticket-pipeline`). Agenci to **zewnętrzne CLI w trybie headless na subskrypcjach** (Claude Code, Codex), wołane przez wspólny kontrakt `EngineAdapter` — Mastra sama NIE wykonuje żadnych wywołań modeli. Pełny plan i decyzje: `../docs/ai-software-factory-plan-v2.md`.

## Mapa kodu

- `src/engines/types.ts` — kontrakt `EngineAdapter.run({role, instructions, context, workspace, budget, model?}) → {ok, report, costUsd?, raw}`. **Adapter nigdy nie rzuca** — błąd = `ok:false`; decyzje podejmują kroki pipeline'u.
- `src/engines/claude-code.ts` — `claude -p --output-format json`; role ≠ build dostają tylko `Read,Glob,Grep`.
- `src/engines/codex.ts` — `codex exec`, sandbox `read-only`/`workspace-write` wg roli; **musi mieć `child.stdin.end()`**.
- `src/engines/index.ts` — rejestr silników (nowy silnik = adapter + wpis + linijka w routing.yaml).
- `src/sources/types.ts` — kontrakt `TicketSource` (BEZ implementacji — Linear to następny duży krok).
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

## Stan na 2026-07-20 późny wieczór

- **Pełny cykl E2E ze wszystkimi krokami działa.** TEST-2 → PR #1 i TEST-3 → PR #2 zmergowane na main. TEST-4 → [PR #3](https://github.com/bartoszrychlicki/pilot-app/pull/3) (draft): plan → ludzka aprobata → build (1 próba) → verify PASS na świeżym checkoutcie → draft PR → **review step uruchomiony po raz pierwszy** — komentarz „LGTM" z sensowną uwagą o czystości `renderFooter` wisi na PR.
- Review step zacommitowany (`eb4bca0`), poprawka repoPath w projects.yaml po przeniesieniu repo pilotowego — osobny commit.
- PR #3 czeka na ludzki merge (human gate — decyzja Bartosza).

## Backlog (uzgodniona kolejność)

1. **Gate na niejasności planu** — niepusta sekcja niejasności w planie → BLOCKED przed bramką aprobaty (TEST-4 pokazał, że człowiek klika nie czytając; builder ignoruje).
1a. **Idempotentne workspace.ts** — przed `worktree add -b` sprzątać pozostałości po poprzednim runie ticketu (prune + usunięcie starej gałęzi/worktree), zamiast padać na `branch already exists`.
2. **TicketSource: Linear** — adapter + polling 60 s (label `agent:ready`), idempotencja `linear:<issue>:v1`, raporty komentarzem; wymaga od Bartosza klucza API Linear i wyboru teamu.
3. **Artefakty `runs/<ticket>/`** — plan, handoffy, raporty, koszty, próby (trwały audit trail poza Studio).
4. **Kimi Code adapter** + routing `build.frontend`.
5. **Izolacja profili CLI** — czysty `CODEX_HOME`/config per run (agent nie dziedziczy prywatnych MCP i skilli Bartosza).
6. **Metryki** — koszt/czas/first-pass rate per etap i silnik (podstawa pod data-driven routing).

Dalsze fazy (br-crm adapter, kontenery, wersja kliencka): `../docs/ai-software-factory-plan-v2.md` §5.

## Zasady (nie łamać)

- Deterministyczny kod robi git/gh/routing/budżety; agenci wyłącznie myślą. Commit robi fabryka, nie agent.
- Fail-closed: niejednoznaczność = STOP z pytaniem, nigdy zgadywanie.
- Human gates: aprobata planu i merge PR są ludzkie. **Nigdy auto-merge.**
- Treść ticketu = niezaufany input (nie może zmieniać polityk, budżetów, uprawnień).
- Verify werdyktuje wyłącznie na świeżym checkoutcie i realnym wykonaniu checks.
- Anty-bloat: nic nie wchodzi do fabryki, dopóki jego brak nie zabolał w pilocie.
