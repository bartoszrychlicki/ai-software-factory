# AI Software Factory — plan v2 (high-level)

**Właściciel:** Bartosz Rychlicki
**Data:** 18 lipca 2026
**Status:** zredefiniowany plan po review v1 (`ai-software-factory-findings-and-plan.md`)
**Cel dokumentu:** minimalna działająca fabryka + ścieżka rozwoju do produktu konsultingowego

---

## 1. Cel — dwa równoległe

1. **Osobisty:** działająca fabryka, która z ticketu robi zweryfikowany draft PR bez ręcznego prowadzenia.
2. **Konsultingowy:** przenośny, powtarzalny artefakt (kod + playbook), wdrażalny u klientów. Hands-on experience z budowy jest częścią wartości.

Ta dwoistość rozstrzyga spory architektoniczne: wybieramy rozwiązania przenośne i zrozumiałe, nawet gdy start trwa kilka dni dłużej.

## 2. Podjęte decyzje

| Obszar | Decyzja | Uzasadnienie |
|---|---|---|
| Orkiestrator | **Mastra** (TS) | workflowy z suspend/resume (human gates), durable execution, przenośność do klientów; Hermes zostaje jako osobisty interfejs/notyfikacje, nie control plane |
| Źródło ticketów | interfejs **TicketSource**, impl. #1: **Linear** | zero pracy na start (oficjalne API/MCP); **br-crm jako adapter #2** w fazie 3 |
| Pilot | małe własne, niewrażliwe repo + 3–5 syntetycznych ticketów | szybka pętla nauki, niskie konsekwencje błędów |
| Silniki MVP | **Claude Code** (plan/verify) + **Codex CLI** (build) | oba skonfigurowane, oba mają tryb headless |
| Silniki później | **Kimi Code CLI** (frontend, faza 2), **LM Studio** (lokalne modele, opcjonalnie) | architektura przewiduje je od dnia 1 (EngineAdapter), implementacja później |
| Rozliczenia | **subskrypcje przez zalogowane CLI**, API tylko jako opcja per silnik | fabryka spawnuje aplikacje (`codex exec`, `claude -p`), nie woła API modeli — szczegóły w §3 |
| Intake | polling co 60 s | bez publicznego endpointu na Macu; webhooki dopiero w fazie 4 |
| Środowisko | lokalny Mac | wystarczy na pilota; always-on Linux host dopiero przy 24/7 |

**Zasady przejęte z v1 bez zmian:** deterministyczna maszyna stanów zamiast swarmu; role jako etapy z kontraktami; krótkie strukturalne handoffy zamiast pełnych transkryptów; świeży checkout do weryfikacji; draft PR + human merge jako nieprzekraczalna granica; fail-closed; idempotency key per ticket.

## 3. Architektura

```text
Linear (label agent:ready)
      │  polling 60 s
      ▼
TicketSource adapter (linear | br-crm | …)
      ▼
Mastra workflow „ticket-pipeline” (state machine per ticket)
  intake → plan → [gate] → build → verify → report
      │
      │  każdy krok agentowy woła:
      ▼
EngineAdapter (wspólny interfejs)
  ├── claude-code   (Agent SDK / claude -p)
  ├── codex         (codex exec, sandbox workspace-write)
  ├── kimi-code     (faza 2)
  └── lmstudio      (stub od dnia 1, implementacja opcjonalna)
      │
      ▼  pracuje w:
Workspace manager: branch + git worktree per ticket
      ▼
GitHub: draft PR → CI → human merge
      ▼
raport + status wracają do TicketSource
```

### Warstwy

1. **TicketSource (adapter)** — `listReady()`, `claim()`, `setStatus()`, `comment()`. Fabryka nie wie, czy rozmawia z Linearem czy br-crm.
2. **Orchestrator (Mastra)** — jeden workflow `ticket-pipeline`. Deterministyczny kod wszędzie, gdzie się da (routing, git, idempotencja, budżety); agent tylko tam, gdzie trzeba rozumowania. Human gate = `suspend()` + powiadomienie, wznowienie po decyzji.
3. **EngineAdapter (interfejs)** — `run({ role, instructions, workspace, context, budget }) → { artifacts, report, cost }`. Silnik = headless proces CLI odpalony w worktree. Nowy silnik = nowy adapter + wpis w routingu; zero zmian w pipeline. **To jest serce pomysłu z multi-agentami.**
4. **Routing = konfiguracja, nie kod** — `routing.yaml`: etap × domena → silnik/model, np. `build.frontend: kimi-code`, `plan: claude-code/sonnet`. Dwie warstwy: `defaults` + sekcja `projects:` (per repo/klient można nadpisać silnik i model — np. projekt X planuje najwyższym modelem, projekt Y używa tylko lokalnego LM Studio). Rozstrzyganie: label `engine:*` na tickecie > config projektu > defaults. Jeśli wybrany model wykracza poza subskrypcję danego CLI, adapter przekazuje mu poświadczenia API przez env (`auth: api`). Router **nie jest LLM-em** w MVP — to reguły. Model dostępny wyłącznie przez UI (bez CLI/API) obsłuży w przyszłości adapter `manual`: suspend → człowiek wkleja prompt do UI i odsyła wynik → resume.
5. **Specjalizacje (profile)** — katalog `profiles/<rola>/`: instrukcje (md), dozwolone narzędzia, skille, limity. Profil jest parametrem `run()`, więc tę samą rolę można odpalić różnymi silnikami — to umożliwia porównywanie silników na tej samej robocie.
6. **Workspace manager** — branch `agent/<ticket>-<slug>`, worktree per ticket, świeży checkout SHA dla verify, sprzątanie po merge.

### Subskrypcje, nie API

`EngineAdapter` spawnuje **zalogowane aplikacje CLI** jako procesy headless — koszty idą więc z subskrypcji, którymi już płacisz:

| Silnik | Tryb headless | Rozliczenie |
|---|---|---|
| Codex CLI | `codex exec` po `codex login` kontem ChatGPT | subskrypcja ChatGPT — wspólny limit z użyciem interaktywnym (okno 5 h + tygodniowy) |
| Claude Code | `claude -p` / Agent SDK | subskrypcja Claude Pro/Max (stan lipiec 2026: zapowiadana osobna pula kredytów SDK — wstrzymana, nadal pula subskrypcji) |
| Kimi Code | CLI po zalogowaniu | Kimi coding plan |
| LM Studio | lokalny serwer OpenAI-compatible | 0 zł, lokalny sprzęt |

Zasady:

- Mastra w pipeline **nie wykonuje żadnych własnych wywołań modeli** (router jest deterministyczny) — nie potrzebuje kluczy API.
- Adapter zawsze odpala samą aplikację; **nie wyciągamy tokenów OAuth z CLI** do własnych wywołań API — to łamie ToS (polityka Anthropic z lutego 2026).
- Fabryka dzieli limity z Twoją pracą interaktywną — stąd budżety per ticket i pomiar kosztów od pierwszego runa.
- Konfig per silnik: `auth: subscription | api`. U klientów zwykle API (przewidywalność, budżet per klucz, brak współdzielenia limitów) — architektura gotowa na oba tryby od dnia 1.

### Role w MVP: 4, nie 5

| Rola | Kto | Domyślny silnik |
|---|---|---|
| Router | deterministyczny kod (nie agent) | — |
| Planner (scout+plan scalone) | agent, repo read-only | Claude Code |
| Builder | agent, write tylko we własnym worktree | Codex CLI |
| Verifier | agent, świeży checkout, bez write | Claude Code |

Scout wraca jako osobna rola dopiero, gdy plany okażą się słabe z braku researchu — decyzja na podstawie danych z pilota, nie z góry.

### Izolacja: sandbox per ticket, warstwowo

Zasada (za Indie Dev Dan): **worktree izoluje kod, ale nie izoluje komputera** — dlatego warstwy, włączane etapami:

| Warstwa | Co daje | Kiedy |
|---|---|---|
| 1. Branch + **git worktree per ticket** | każdy ticket = osobny katalog + osobny branch → równoległe tickety fizycznie nie mogą się nadpisywać; tworzenie w sekundy | MVP |
| 2. Sandbox silnika wewnątrz worktree | Codex `workspace-write` (zapis tylko w katalogu roboczym, ograniczona sieć), permission mode Claude Code; Verifier zawsze na świeżym checkoucie SHA, bez prawa zapisu | MVP |
| 3. Kontener per run (OrbStack) | izolacja hosta: osobny HOME, brak `~/.ssh` i tokenów, limity CPU/RAM/czasu, egress allowlist | faza 3 |

„Sandbox per ticket" realizujemy więc od dnia 1 warstwami 1+2 — to załatwia problem nadpisywania się agentów. Warstwa 3 broni **hosta i sekretów**, nie kodu; wchodzi zanim fabryka dostanie mniej zaufane tickety lub większą równoległość. Praktyka: wspólny cache pakietów (pnpm store) między worktree, żeby każda instalacja nie bolała.

### Ryzyko: 2 klasy zamiast R0–R4

- **normal** — pipeline automatycznie dochodzi do draft PR;
- **sensitive** (auth, płatności, migracje, sekrety, usuwanie danych — wykrywane regułami po ścieżkach plików i labelach) — stop i human gate przed buildem.

Pełna matryca R0–R4 z v1 wraca w wersji klienckiej (faza 4) — to dobry materiał na warsztat z klientem, nie na Twoje MVP.

## 4. Engineering loop — droga ticketu i decyzje

```text
Linear: człowiek nadaje label agent:ready
  │
  ▼
INTAKE — deterministyczny kod
  • idempotencja: pipeline dla ticketu już istnieje? → zignoruj
  • kompletność (AC, mapping repo)? → brak: „Needs Clarification” + komentarz, STOP
  • klasyfikacja regułami: kind (bug/feature/chore) + risk (normal/sensitive)
  • manifest + branch + worktree
  │
  ▼
PLAN — agent (claude-code), repo read-only
  • output wg kontraktu (§6)
  • lista niejasności niepusta → BLOCKED: pytania jako komentarz → człowiek odpowiada → re-plan
  • risk = sensitive → GATE #1: człowiek akceptuje plan (suspend/resume)
  │
  ▼
BUILD — agent wg routing.yaml (domyślnie codex), zapis tylko we własnym worktree
  • implementacja + testy lokalne + commity
  • push brancha + draft PR przy pierwszej udanej próbie
  • fail → retry (łącznie max 2 próby) → nadal fail: BLOCKED
  │
  ▼
VERIFY — agent (claude-code), świeży checkout SHA z PR, bez prawa zapisu
  • sam uruchamia testy/build/lint — nie ufa raportowi buildera
  • sprawdza: AC ↔ dowody, diff w zakresie planu, brak zmian obok
  • FAIL → strukturalny feedback → BUILD-FIX #n (nowy krok, nie pętla w miejscu)
  •   max 2 rundy fix → nadal FAIL: BLOCKED + pełny raport
  │
  ▼
REPORT — deterministyczny kod
  • PR: opis (plan, dowody verify, koszty) + ready-for-review
  • Linear: komentarz z podsumowaniem, status „Human Review”
  │
  ▼
GATE #2 — człowiek w GitHubie: review + merge
  • merge → sprzątanie worktree, Linear: Done
  • changes requested → komentarze PR jako feedback do BUILD-FIX (faza 2+)
```

Kto podejmuje którą decyzję:

| Decyzja | Kto |
|---|---|
| aktywacja ticketu, akceptacja planu (sensitive), merge, unblock | człowiek |
| kompletność, klasyfikacja, routing silnika, budżety, limity prób, idempotencja | deterministyczny kod |
| treść planu, implementacja, werdykt verify (pass/fail z dowodami) | agenci |

Inwarianty pętli:

- każdy powrót (fix) to **nowy krok z feedbackiem poprzednika**, nigdy mutowanie w miejscu — pełna historia w `runs/<ticket>/`;
- agent nie może obniżyć ryzyka, zwiększyć własnego budżetu ani ominąć gate'a;
- stan niejednoznaczny → BLOCKED (fail-closed), nigdy zgadywanie;
- BLOCKED zawsze zostawia w Linear konkretne pytanie/przyczynę i czeka na człowieka.

### Dekompozycja: gdy ticket ma frontend i backend

Zasada podziału odpowiedzialności: **dekompozycję proponuje Planner** (to rozumowanie — trafia do planu), **materializuje ją Router** (deterministycznie: walidacja, silniki, budżety), Builder tylko wykonuje swój wycinek. Oraz: jeden ticket = jeden PR.

Trzy poziomy, włączane w tej kolejności:

| Poziom | Mechanizm | Kiedy |
|---|---|---|
| 0. Subagenci silnika | Claude Code subagents / wbudowane subagenty Kimi — wewnątrz jednego runa Buildera; fabryka o tym nie wie | MVP, za darmo |
| 1. Sub-buildy sekwencyjne | plan zawiera `subtasks` z zależnościami (backend → frontend); orkiestrator wykonuje je kolejno **w tym samym worktree i branchu**, każdy może iść innym silnikiem (`build.backend: codex`, `build.frontend: kimi-code`); jeden draft PR, jeden verify całości | faza 2 |
| 2. Sub-buildy równoległe | osobny worktree per domena + rozłączne zakresy plików + krok integracji | po pilocie, tylko jeśli sekwencyjnie okaże się za wolno |

Mechanika poziomu 1:

- Planner definiuje w planie: subtaski (domena + zakres ścieżek), **kontrakt między nimi** (np. schemat API / typy) i kolejność;
- Router waliduje (zakresy rozłączne? kontrakt zdefiniowany?), przypisuje silniki z `routing.yaml`, dzieli budżet per subtask;
- każdy sub-build dostaje handoff: plan + kontrakt + wynik poprzedniego sub-buildu;
- verify jest jeden, na zintegrowanym SHA — sub-buildy to szczegół wykonania, nie osobne pipeline'y.

Guardrail: jeśli plan pokazuje, że części są naprawdę niezależne (osobne kryteria akceptacji, osobno wdrażalne) — to nie są subtaski, to **dwa tickety**. Router odsyła ticket z propozycją podziału na sub-issues w Linear; każde idzie własnym pipeline'em i własnym PR-em.

Dlaczego nie równolegle od razu: równoległe pisanie w jednym repo to konflikty merge i failury integracji — dokładnie ten problem, który izolacja per ticket miała wyeliminować. Sekwencyjny łańcuch w jednym worktree daje główną wartość (właściwy silnik do właściwej domeny) bez tych kosztów.

## 5. Fazy

### Faza 0 — fundamenty (1–2 dni)

Repo `ai-factory` (scaffold Mastra); repo pilotowe z branch protection na `main` (wymagany PR + zielone CI); CI: lint, typecheck, testy; 3–5 syntetycznych ticketów w Linear; mapping projekt→repo w konfigu; typy `TicketSource` i `EngineAdapter`.

**Exit:** ręczne odpalenie pipeline z konsoli dla jednego ticketu przechodzi intake i tworzy branch + worktree.

### Faza 1 — MVP: ticket → draft PR (tydzień 1–2)

Pełny przepływ: polling → plan (Claude Code) → build (Codex, worktree) → verify (świeży checkout) → draft PR + raport w Linear. Handoffy zapisywane jako pliki w `runs/<ticket>/`. Retry: max 2 próby buildera, potem `blocked` + komentarz. Human gates: aktywacja labelem i merge; plan gate tylko dla `sensitive`.

**Exit:** 3 z 5 syntetycznych ticketów kończy jako sensowny draft PR bez ręcznego prowadzenia; przerwany run daje się wznowić; verifier łapie celowo wstrzyknięty błąd; retry nie duplikuje pipeline'u.

### Faza 2 — multi-engine i frontend lane (tydzień 3–4)

Adapter Kimi Code + routing `build.frontend → kimi-code`; override `engine:*`; sub-buildy sekwencyjne per domena (poziom 1 dekompozycji z §4) — jeden ticket fullstack przechodzi backend przez Codex i frontend przez Kimi w tym samym worktree; Vercel Preview + Playwright smoke w verify dla frontendu; metryki per run (koszt, czas, first-pass rate) do SQLite/plików.

**Exit:** ten sam ticket frontendowy przechodzi raz przez Kimi, raz przez Codex; routing wybiera z konfiguracji; są metryki porównawcze silników.

### Faza 3 — br-crm i twardsza izolacja (miesiąc 2)

Adapter TicketSource dla br-crm (+ minimalne API po stronie br-crm); kontener per builder run (OrbStack): izolowany HOME, bez hostowych credentiali, limity zasobów; budżety kosztów per ticket i circuit breaker.

**Exit:** ticket z br-crm przechodzi identyczny pipeline; builder nie widzi `~/.ssh` ani tokenów innych ról.

### Faza 4 — wersja kliencka (miesiąc 2–3)

Templatyzacja: config per klient (repo, źródło ticketów, routing, polityki); playbook wdrożeniowy + demo. Przywrócenie z v1 tego, czego potrzebuje klient enterprise: matryca ryzyka R0–R4, webhooki + reconciliation, deployment gates, pełny audit trail. Opcjonalnie: adapter LM Studio (klienci z wymogiem on-prem/prywatności).

**Exit:** fabryka stawiana u klienta w ≤1 dzień z checklisty.

## 6. Kontrakty (minimum)

Manifest tworzony przez Router:

```yaml
ticket: LIN-123
source: linear
repo: org/pilot-app
kind: bug | feature | chore
risk: normal | sensitive
branch: agent/LIN-123-slug
routing: { plan: claude-code, build: codex, verify: claude-code }
budget: { attempts: 2, minutes: 45 }
idempotency: linear:LIN-123:v1
```

- **plan → build:** zakres / poza zakresem; kryteria akceptacji → sposób weryfikacji każdego; plan zmian per plik; plan testów; niejasności (niepuste ⇒ stop); opcjonalnie `subtasks` (domena, zakres ścieżek, kontrakt, kolejność — §4).
- **build → verify:** commity; zmienione pliki; wyniki testów lokalnych; odstępstwa od planu; instrukcja weryfikacji.
- **verify → report:** werdykt pass/fail z dowodami; przy fail Router tworzy `build-fix#2` z feedbackiem verifiera (nowy krok, nie pętla w miejscu).

Treść ticketu to niezaufany input: do promptów wchodzą tylko nazwane pola; ticket nie może zmieniać polityk, budżetów ani uprawnień.

## 7. Wycięte z v1 — i kiedy wraca

| Element v1 | Teraz | Wraca |
|---|---|---|
| R0–R4 + CODEOWNERS | normal / sensitive | faza 4 (klienci) |
| kontenery, egress allowlist, izolowany HOME | worktree + sandbox CLI | faza 3 |
| webhook + HMAC + kolejka + reconciliation | polling | faza 4 |
| migration runner, expand/contract | poza zakresem | wdrożenia klienckie |
| canary, feature flags, auto-deploy, smoke prod | poza zakresem (fabryka kończy na PR) | faza 4+ |
| powiadomienia Telegram | komentarze w Linear (+ ew. Hermes) | dowolnie |
| Hermes jako control plane | zastąpiony przez Mastra | Hermes = interfejs osobisty |
| 5 profili | 4 role (scout ⊂ planner) | gdy dane pokażą potrzebę |
| hotfix workflow, solution racing, auto-decompose | poza zakresem | po stabilnym pilocie |

## 8. Ryzyka i zasady higieny

- Sandbox Codexa/Claude nie izoluje hosta — do fazy 3 wyłącznie własne, zaufane tickety.
- Największe realne ryzyko projektu to **over-engineering**. Reguła: nic nie wchodzi do fabryki, dopóki jego brak nie zabolał w pilocie.
- Koszty tokenów mierzone od pierwszego runa (per etap, per silnik) — bez tego routing nigdy nie będzie oparty na danych.
- Werdykty verifiera muszą opierać się na uruchomionych komendach (testy, build), nie na czytaniu diffu.

## 9. Pierwsze kroki (dzień 1)

1. `npm create mastra@latest` → repo `ai-factory`; struktura: `src/sources/`, `src/engines/`, `src/pipeline/`, `profiles/`, `routing.yaml`, `runs/`.
2. Zdefiniować typy `TicketSource` i `EngineAdapter` (30 minut, a ustawia całą przenośność).
3. Adapter `claude-code` (headless) + smoke test: „przygotuj plan dla ticketu X w repo Y".
4. Wybrać repo pilotowe, włączyć branch protection, napisać pierwszy syntetyczny ticket w Linear.

## 10. Linki

- Mastra — workflows, suspend/resume, durable agents: https://mastra.ai/docs
- Claude Agent SDK / headless: https://code.claude.com/docs
- Codex CLI (`codex exec`): https://github.com/openai/codex
- Kimi Code CLI (MIT, TS): https://github.com/MoonshotAI/kimi-code
- Linear API/MCP: https://linear.app/docs/mcp
- Codex na planie ChatGPT: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- Claude Code na Pro/Max: https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- Agent SDK na planie Claude: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Wideo (Indie Dev Dan, worktree/sandbox, 13:00–25:00): https://www.youtube.com/watch?v=VQy50fuxI34&t=916s
- v1 (pełny research, wraca w fazie 4): `ai-software-factory-findings-and-plan.md`
