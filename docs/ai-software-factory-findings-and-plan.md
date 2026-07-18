# AI Software Factory — findings, architektura i plan wdrożenia

**Właściciel:** Bartosz Rychlicki  
**Data:** 17 lipca 2026  
**Status:** propozycja architektury i plan pilota  
**Zakres:** półautomatyczna obsługa ticketów software od Linear do zweryfikowanego PR-a, wdrożenia i zamknięcia zadania

---

## 1. Executive summary

Celem jest zbudowanie małej, kontrolowanej „fabryki software”, w której ticket po oznaczeniu jako gotowy trafia do trwałego workflow obsługiwanego przez kilka wyspecjalizowanych agentów. Agenci wykonują research, planowanie, implementację i QA, natomiast człowiek pojawia się tylko w jawnych bramkach decyzyjnych.

Rekomendowany model nie jest swobodnym swarmem agentów. To **deterministyczna maszyna stanów**, w której:

- Linear jest źródłem prawdy dla intencji biznesowej i statusu ticketu;
- Hermes Kanban jest źródłem prawdy dla wykonania, zależności, prób, blokad i handoffów;
- GitHub jest źródłem prawdy dla kodu, diffu, review, CI i merge;
- Vercel jest źródłem prawdy dla preview i deploymentu;
- OpenViking przechowuje wiedzę projektową, decyzje i kontekst długoterminowy;
- człowiek zatwierdza rozpoczęcie pracy, merge oraz operacje podwyższonego ryzyka.

Docelowy podstawowy przepływ:

```text
Linear: Ready for Agents
        │
        ▼
Router / Orchestrator
        │
        ▼
Scout → Planner → [warunkowa akceptacja planu]
        │
        ▼
Builder w izolowanym worktree i sandboxie
        │
        ▼
GitHub Draft PR + Vercel Preview
        │
        ▼
Verifier / CI / QA / security review
        │
        ├── FAIL → fix task dla Buildera → ponowna weryfikacja
        │
        ▼
Human gate: merge
        │
        ▼
Deploy → smoke test → monitoring
        │
        ▼
Linear: Done + raport końcowy
```

Dla typowego zadania niskiego ryzyka człowiek wykonuje tylko dwie czynności:

1. oznacza ticket jako `Ready for Agents`;
2. akceptuje i scala gotowy PR.

Dodatkowe bramki uruchamiają się tylko dla zmian podwyższonego ryzyka: auth, billing, PII, infrastruktura, produkcyjne migracje, usuwanie danych, breaking API i operacje nieodwracalne.

---

## 2. Findings z filmu i researchu

Punktem wyjścia był materiał Indie Dev Dan „FORGET Loop Engineering. Agentic Engineering is about THIS”, szczególnie fragment 13:00–25:00.

### 2.1. Główna teza

Najbardziej użyteczną jednostką projektową nie jest pojedynczy „agent w pętli”, lecz **AI developer workflow**. Workflow łączy trzy typy wykonawców:

1. deterministyczny kod i reguły;
2. agentów wykonujących pracę wymagającą rozumowania;
3. ludzi podejmujących decyzje odpowiedzialności i ryzyka.

Ticket nie powinien być wrzucany do jednego wszechmocnego agenta z poleceniem „zrób wszystko”. Powinien przechodzić przez wyspecjalizowane etapy z jasno zdefiniowanymi kontraktami wejścia i wyjścia.

### 2.2. Najważniejsze wzorce

- **Router oparty głównie na regułach.** Model może doprecyzować klasyfikację, ale nie powinien sam obniżać poziomu ryzyka ani usuwać obowiązkowych bramek.
- **Role są etapami i kontraktami, nie osobowościami.** Scout, Planner, Builder i Verifier mogą być kolejnymi izolowanymi uruchomieniami modeli.
- **Krótki, strukturalny handoff.** Następny agent dostaje ticket, zaakceptowane artefakty poprzednika i potrzebny kontekst, a nie cały transcript.
- **CI jest źródłem prawdy dla testów.** Tester-agent pomaga projektować i diagnozować testy, ale nie zastępuje realnego wykonania testów.
- **Reviewer powinien być niezależny.** Nie powinien zatwierdzać kodu, który sam wygenerował, ani zmieniać oczekiwań testów tylko po to, aby build przeszedł.
- **Każdy ticket i każda próba mają izolowane środowisko.** Worktree izoluje kod, a kontener lub VM izoluje hosta, procesy, sieć i sekrety.
- **Automatyzacja jest zależna od ryzyka.** Niskie ryzyko może dojść automatycznie do PR-a; wysokie ryzyko wymaga dodatkowej kontroli.
- **Najpierw prosty pipeline.** Stały DAG jest bezpieczniejszy niż dynamiczny swarm. Dynamiczna dekompozycja powinna wejść dopiero po ustabilizowaniu pilota.

### 2.3. Rekomendacja technologiczna

Nie rekomendujemy na pierwszym etapie budowania osobnej platformy orkiestracyjnej w LangGraph, CrewAI czy Temporal. Obecny Hermes `0.18.2` posiada już:

- trwały Kanban i dispatcher;
- zależności między zadaniami;
- nazwane profile;
- osobne workspaces i git worktrees;
- retry, crash recovery i circuit breaker;
- komentarze, run history i metadane;
- human-in-the-loop przez `blocked` / `unblock`;
- webhooki i cron;
- Codex App-Server Runtime;
- integrację z modelami, MCP i narzędziami projektowymi.

Temporal może mieć sens później, jeżeli workflow zaczną trwać tygodniami, obejmować wiele zewnętrznych systemów i wymagać formalnego replayu zdarzeń. Na pilota Hermes Kanban jest wystarczającym control plane.

---

## 3. Stan obecny środowiska

Zweryfikowany stan na 17 lipca 2026:

- Hermes Agent `v0.18.2 (2026.7.7.2)`;
- profil `cto` działa pod gatewayem launchd;
- dispatcher Hermes Kanban działa w gatewayu;
- interwał dispatchera: 60 sekund;
- `auto_decompose: true`;
- `failure_limit: 2`;
- bieżący board nie ma aktywnych zadań i ma historię wykonanych tasków;
- dostępne są profile: `default`, `cfo`, `coo`, `cto`, `manager`, `terapeuta`;
- Linear MCP nie jest jeszcze skonfigurowany w Hermesie;
- platforma Hermes Webhook nie jest jeszcze włączona dla profilu `cto`;
- Codex App-Server Runtime nie jest jeszcze włączony w konfiguracji Hermesa;
- dostępne są GitHub CLI, Codex CLI, Vercel oraz lokalne repozytoria;
- OpenViking jest skonfigurowany jako MCP/resource store, choć dostęp musi być sprawdzany per profil i tenant.

---

## 4. Docelowe role — pięć profili

### 4.1. `software-router`

**Odpowiedzialność:** intake, klasyfikacja, routing i synchronizacja lifecycle’u.

Dostęp:

- Linear MCP: odczyt i ograniczony zapis;
- Hermes Kanban: tworzenie, linkowanie, komentowanie, blokowanie i odblokowanie;
- GitHub/Vercel: odczyt statusów;
- brak narzędzi do edycji kodu;
- brak dostępu do sekretów produkcyjnych.

Zadania:

1. wykrycie ticketu `Ready for Agents`;
2. walidacja kompletności;
3. identyfikacja projektu i repozytorium;
4. przypisanie klasy `chore`, `bug`, `feature`, `hotfix`;
5. przypisanie klasy ryzyka `R0–R4`;
6. utworzenie manifestu wykonania;
7. utworzenie stałego DAG-u w Kanbanie;
8. synchronizacja komentarzy i statusów;
9. eskalacja do człowieka, gdy dane są niekompletne lub sprzeczne.

Przykładowy manifest:

```yaml
issue: LIN-123
repository: org/repo
kind: bug
risk: R1
workflow: reproduce-first
branch: agent/LIN-123-short-title
required_gates:
  - ci
  - independent-review
  - human-merge
max_builder_attempts: 2
max_runtime_minutes: 45
production_gate: false
```

### 4.2. `software-scout`

**Odpowiedzialność:** zebranie dowodów i kontekstu.

Dostęp:

- repozytorium tylko do odczytu;
- Git i GitHub read-only;
- OpenViking i dokumentacja;
- web do aktualnej dokumentacji technicznej;
- brak push, deploy i zapisu do produkcji.

Raport Scouta powinien zawierać:

- pliki, symbole i moduły związane z ticketem;
- obecne zachowanie i sposób reprodukcji;
- istniejące testy;
- zależności i kontrakty;
- podobne PR-y i wcześniejsze decyzje;
- potencjalne migracje;
- ryzyka bezpieczeństwa i regresji;
- komendy potrzebne do weryfikacji;
- pytania wymagające decyzji człowieka.

Scout zwraca pakiet dowodów, a nie rozbudowany esej bez referencji.

### 4.3. `software-planner`

**Odpowiedzialność:** przygotowanie implementowalnego planu.

Dostęp:

- ticket i output Scouta;
- repozytorium read-only;
- komentarze i artefakty Kanbanu;
- brak prawa modyfikacji kodu.

Output:

- zakres i brak zakresu;
- kryteria akceptacji;
- plan zmian plik po pliku;
- test plan;
- plan migracji;
- rollback lub roll-forward;
- ocenę ryzyka;
- wymagane bramki;
- listę niejasności.

Plan powinien mapować każde kryterium akceptacji na co najmniej jeden sposób weryfikacji.

### 4.4. `software-builder`

**Odpowiedzialność:** implementacja zaakceptowanego planu.

Dostęp:

- izolowany worktree;
- zapis wyłącznie w workspace ticketu;
- Codex App-Server Runtime albo kontrolowane uruchomienie Codex CLI;
- krótkotrwałe uprawnienie do pushowania branchy i otwierania PR-ów;
- brak merge do `main`;
- brak produkcyjnych sekretów i deploy credentials.

Output:

- commit lub sekwencja commitów;
- draft PR;
- lista zmienionych plików;
- wyniki testów lokalnych;
- odstępstwa od planu;
- znane ograniczenia;
- instrukcja weryfikacji.

### 4.5. `software-verifier`

**Odpowiedzialność:** niezależna weryfikacja.

Dostęp:

- świeży checkout dokładnego SHA z PR-a;
- GitHub read-only i możliwość publikacji review;
- Vercel Preview;
- testy, browser/Playwright i narzędzia security;
- brak merge;
- brak domyślnego prawa poprawiania kodu.

Verifier sprawdza:

- zgodność z ticketem i planem;
- poprawność logiki;
- testy unit/integration/e2e;
- bezpieczeństwo;
- backward compatibility;
- migracje;
- UX/UI i dostępność dla frontendu;
- zachowanie Vercel Preview;
- czy PR nie zawiera zmian poza zakresem.

Przy błędzie Verifier tworzy strukturalny raport i osobny fix task dla Buildera. Nie „naprawia i zatwierdza” własnych zmian w tym samym runie.

---

## 5. Lifecycle i maszyna stanów

### 5.1. Stany biznesowe w Linear

Proponowane stany lub etykiety:

```text
Draft
Needs Clarification
Ready for Agents
In Agent Planning
Plan Approval Required
In Agent Build
Agent QA
Human Review
Ready for Production
Deployed
Done
Blocked
```

Nie wszystkie muszą być osobnymi kolumnami. Część może być etykietami lub komentarzami, aby nie rozbudować Linear ponad potrzebę.

### 5.2. Stany wykonawcze w Kanbanie

Hermes posiada:

```text
triage → todo → ready → running → blocked → done → archived
```

Każdy etap software factory jest osobnym taskiem Kanban z parent linkiem. Gdy parent kończy się sukcesem, dziecko przechodzi z `todo` do `ready`.

### 5.3. Stały DAG pilota

```text
Parent: Linear LIN-123
  └── Scout LIN-123
       └── Plan LIN-123
            └── Build LIN-123
                 └── Verify LIN-123
                      └── Release verification LIN-123
```

Nie należy tworzyć cyklicznych zależności w DAG-u. Gdy Verify kończy się błędem, Router tworzy nowe zadania:

```text
Build fix #2 → Verify #2
```

Oba są linkowane z poprzednim review i zawierają jego structured feedback.

### 5.4. Idempotency

Każdy intake używa stabilnego klucza:

```text
linear:<workspace-id>:<issue-id>:workflow-v1
```

Retry webhooka, restart watchera ani ponowna synchronizacja nie mogą tworzyć drugiego pipeline’u dla tego samego ticketu. Nowy pipeline wymaga jawnego nowego numeru workflow albo ręcznego resetu.

---

## 6. Workflow według typu zadania

### 6.1. Chore / R0–R1

```text
Router → opcjonalny Scout → Builder → Verifier → Human merge → auto deploy
```

Plan może być generowany automatycznie i nie wymagać osobnej zgody.

### 6.2. Bug / R1–R2

```text
Router → Scout/reprodukcja → Planner → Builder z testem regresji
→ Verifier → Human merge → deploy → smoke
```

Test reprodukujący błąd powinien być utworzony przed poprawką lub równolegle z nią. Niedopuszczalne jest zmienianie oczekiwań tylko po to, aby test przeszedł.

### 6.3. Feature / R1–R3

```text
Router → Scout → Planner → warunkowa akceptacja planu
→ Builder → Verifier → UAT/Preview → Human merge
→ warunkowa akceptacja produkcji
```

### 6.4. Hotfix

Hotfix nie powinien być pierwszym workflow pilota.

Docelowo:

```text
Incydent → Scout → propozycja minimalnej zmiany → Human strategy gate
→ 2–3 równoległe sandboxy Buildera
→ wybór najlepszego poprawnego rozwiązania
→ Verifier → Human release gate → deploy → monitoring
```

Hotfix agent ma optymalizować minimalny blast radius i czas przywrócenia usługi, nie refaktoryzację i elegancję.

---

## 7. Sandboxing i izolacja

### 7.1. Zasada

**Worktree izoluje kod, ale nie izoluje komputera.** Pełny model składa się z kilku warstw:

1. branch per ticket;
2. worktree per ticket lub próba;
3. sandbox procesowy Codexa;
4. kontener lub efemeryczna VM;
5. izolowany `HOME`;
6. minimalne poświadczenia;
7. egress allowlist;
8. limity zasobów i czasu;
9. oddzielny deploy runner poza agentem.

### 7.2. Struktura per ticket

```text
LIN-123
├── branch: agent/LIN-123-short-title
├── builder worktree: .worktrees/LIN-123-builder/
├── verify worktree: .worktrees/LIN-123-verify-<sha>/
├── isolated HOME
├── per-run logs
├── resource and token budgets
└── Kanban run history
```

### 7.3. Scout i Planner

- read-only snapshot konkretnego commit SHA;
- brak write tools albo write sandbox;
- brak GitHub write token;
- brak dostępu do katalogów innych projektów;
- brak produkcyjnych danych.

### 7.4. Builder

- canonical worktree ticketu;
- `workspace-write` wyłącznie w katalogu worktree;
- osobny branch;
- zakaz direct push do `main`;
- GitHub token ograniczony do repo i operacji branch/PR;
- brak Vercel production token;
- brak dostępu do lokalnego `~/.ssh`, `~/.aws`, `~/.gh` i innych profili.

### 7.5. Verifier

Verifier nie testuje w katalogu pozostawionym przez Buildera. Dostaje świeży checkout SHA z PR-a. Pozwala to wykryć:

- niezacommitowane pliki;
- zależność od lokalnego cache;
- przypadkowe pliki generowane;
- testy przechodzące wyłącznie w brudnym środowisku;
- różnicę między deklarowanym a faktycznym artefaktem.

### 7.6. Kontener docelowy

```text
Hermes Kanban
  → tworzy worktree
  → uruchamia efemeryczny kontener
      → /workspace = mount konkretnego worktree
      → oddzielny HOME
      → non-root user
      → read-only root filesystem
      → tmpfs dla /tmp
      → brak Docker socket
      → drop Linux capabilities
      → CPU/RAM/PID/time limits
      → sieć wyłączona lub egress przez allowlist proxy
      → tylko krótkotrwałe poświadczenia danego etapu
  → worker wykonuje task i raportuje wynik
  → kontener jest niszczony
  → worktree/PR/log pozostają do audytu
```

Na Macu pilot może używać Docker Desktop lub OrbStack. Docelowo 24/7 stabilniejsze będzie uruchamianie workerów na małym hoście Linux lub w efemerycznych VM.

### 7.7. Ograniczenia Codex App-Server Runtime

Codex zapewnia sandbox `workspace-write` i w Kanbanie domyślnie ogranicza sieć. To dobra pierwsza warstwa, ale proces nadal działa na hoście. Worktree i Seatbelt nie powinny być jedyną granicą zaufania, ponieważ proces hosta może potencjalnie widzieć realny `HOME`, konfigurację CLI i inne zasoby użytkownika.

Dlatego:

- pilot z zaufanymi, wewnętrznymi ticketami może zacząć od worktree + Codex sandbox;
- przed przyjmowaniem szerokiego lub zewnętrznego inputu należy przejść do kontenerów z izolowanym `HOME`;
- żaden agent nie powinien otrzymywać wspólnego profilu `cto` ze wszystkimi istniejącymi credentialami.

---

## 8. Linear intake

### 8.1. Rekomendowany MVP — polling

Na pierwszym etapie watcher uruchamiany co minutę:

1. pobiera z Linear tickety `Ready for Agents`;
2. sprawdza idempotency key;
3. tworzy parent task w Kanbanie;
4. ustawia Linear na `In Progress`;
5. publikuje komentarz z workflow ID;
6. tworzy deterministyczny DAG.

Zalety:

- brak publicznego endpointu na Macu;
- działa za NAT-em;
- prosty retry i reconciliation;
- łatwe zatrzymanie automatyzacji;
- wystarczająca szybkość dla większości ticketów.

Linear ma oficjalny remote MCP:

```text
https://mcp.linear.app/mcp
```

MCP powinien być skonfigurowany tylko dla Routera. Pozostali agenci otrzymują potrzebne dane przez structured handoff, a nie bezpośredni szeroki dostęp do Linear.

### 8.2. Docelowy webhook

```text
Linear
  → Vercel Function / Cloudflare Worker
  → walidacja Linear-Signature na raw body
  → sprawdzenie webhookTimestamp
  → filtr statusu i etykiet
  → normalizacja payloadu
  → ponowne podpisanie Hermes Generic Webhook V2
  → Hermes route linear-intake
  → Router/Kanban
```

Adapter jest potrzebny, ponieważ Linear używa własnych nagłówków `Linear-Signature` i `Linear-Timestamp`, natomiast Hermes natywnie obsługuje GitHub, GitLab i Generic Webhook V2.

Endpoint Linear powinien odpowiedzieć `HTTP 200` w czasie krótszym niż pięć sekund. Linear ponawia nieudane dostarczenie po około minucie, godzinie i sześciu godzinach. Endpoint nie powinien prowadzić całego workflow synchronicznie; powinien uwierzytelnić i zapisać event do trwałej kolejki.

### 8.3. Bezpieczeństwo ticketu

Opis ticketu jest niezaufanym inputem. Poprawny podpis webhooka uwierzytelnia Linear jako nadawcę, ale nie czyni treści ticketu zaufaną instrukcją.

Router przekazuje tylko nazwane pola:

- issue ID;
- title;
- description jako dane;
- labels;
- priority;
- repository mapping;
- acceptance criteria;
- actor;
- URL;
- changed status.

Ticket nie może modyfikować polityk, wyłączać testów, żądać sekretów ani podnosić uprawnień agenta.

---

## 9. Human gates i model ryzyka

### 9.1. Klasy ryzyka

| Klasa | Przykłady | Minimalny tryb |
|---|---|---|
| R0 | dokumentacja, komentarze, bezpieczne fixtures | automatyczny PR, 1 human merge |
| R1 | mały bugfix, izolowany UI, feature flag off | 1 CODEOWNER, auto deploy po merge |
| R2 | API, logika domenowa, zależności runtime | human merge + zgoda produkcyjna |
| R3 | auth, billing, PII, IAM, infrastruktura, migracja danych | 2 aprobaty, rehearsal, jawne okno wdrożenia |
| R4 | destructive migration, usuwanie danych, zmiana granic zaufania | zasada czterech oczu, DBA/SRE/security, kontrolowane wykonanie |

Agent może automatycznie podnieść ryzyko. Obniżenie ryzyka wymaga człowieka i uzasadnienia zapisanego w audycie.

### 9.2. Bezwzględne bramki ludzkie

1. aktywacja ticketu przez `Ready for Agents`;
2. merge kodu wygenerowanego przez agentów;
3. wyjątek od polityki, czerwonego checku lub limitu;
4. zmiany w auth/IAM, PII, billing, sekretach i guardrailach;
5. produkcja dla R2–R4;
6. nieodwracalne lub masowe migracje;
7. trwałe działania destrukcyjne podczas incydentu.

### 9.3. Świadoma aprobata

Aprobata nie powinna być pustym kliknięciem. Bramka pokazuje:

- ticket i acceptance criteria;
- risk score i jego przesłanki;
- plan;
- diff;
- test evidence;
- raport Verifiera;
- Vercel Preview;
- plan deploymentu i rollbacku;
- migracje i wpływ na dane.

---

## 10. GitHub i CI jako guardrail

`main` powinien mieć GitHub Ruleset lub branch protection:

- zakaz direct push;
- zakaz force push i kasowania;
- wymagany pull request;
- wymagane checks dla aktualnego SHA;
- wymagany human review;
- wymagany CODEOWNER dla wrażliwych ścieżek;
- dismiss stale approvals po nowym pushu;
- require conversation resolution;
- brak bypassu również dla administratora lub automation, jeśli organizacja na to pozwala;
- merge queue przy większej równoległości.

Minimalne checks:

- lint i format;
- typecheck;
- unit tests;
- integration/contract tests;
- E2E zależnie od obszaru;
- test regresyjny dla bugfixu;
- secret scan;
- dependency/SCA;
- SAST;
- migration validation;
- build;
- Vercel Preview;
- smoke test Preview;
- niezależny AI review jako dodatkowy check, nie substytut człowieka.

Dla frontendu:

- Playwright;
- desktop i mobile screenshots;
- accessibility smoke;
- kontrola console errors;
- weryfikacja głównych flows;
- opcjonalnie visual diff.

---

## 11. Vercel i deployment

Builder nie powinien mieć prawa do produkcyjnego deployu. Push do PR uruchamia Vercel Preview przez integrację GitHub.

Verifier testuje Preview i zapisuje URL oraz wyniki.

Po merge:

- R0–R1: produkcja może wdrożyć się automatycznie, jeżeli wszystkie checks są zielone;
- R2–R4: wymagany manual production gate;
- krytyczne zmiany powinny używać canary/feature flag;
- artefakt promowany na produkcję powinien odpowiadać zweryfikowanemu commitowi;
- po deploymentcie uruchamiany jest smoke test i monitoring okna stabilizacji.

Vercel Deployment Protection powinno chronić Preview przed publicznym dostępem, a Verifier powinien używać dedykowanego mechanizmu automation bypass, nie współdzielonego hasła człowieka.

---

## 12. Migracje danych

Migracje R3–R4 powinny używać wzorca:

```text
expand → migrate/backfill → switch → contract
```

Wymagania:

- backward-compatible expand;
- oddzielenie migracji schema od dużego backfillu;
- dry-run lub rehearsal na zanonimizowanej kopii;
- checkpointy i resumability;
- kontrola lock time;
- mierzalne tempo i ETA;
- backup/PITR potwierdzony przed produkcją;
- plan roll-forward i rollback;
- osobny migration runner z oddzielną tożsamością;
- zakaz wykonywania migracji przez Buildera;
- human gate przed operacją destrukcyjną;
- kontrakcja starego schema dopiero po okresie stabilizacji.

---

## 13. Uprawnienia i sekrety

| Rola | Dozwolone | Niedozwolone |
|---|---|---|
| Router | Linear/Kanban write, GitHub/Vercel read | kod, merge, deploy, produkcyjne sekrety |
| Scout | repo/GitHub/OpenViking read | write, push, deploy |
| Planner | ticket/context/repo read, plan write | kod, push, deploy |
| Builder | workspace write, branch push, draft PR | main, merge, prod, inne repo |
| Verifier | clean checkout, tests, PR review, Preview read | kod write, merge, prod |
| CI/Deploy bot | build/deploy dla wskazanego SHA | swobodne działania poza pipeline |
| Migration runner | konkretna migracja w zatwierdzonym oknie | ogólny dostęp administracyjny |

Zasady:

- brak współdzielonych tokenów;
- tokeny krótkotrwałe lub rotowane;
- osobne tożsamości per rola;
- scope per repo i operacja;
- secrets poza promptem, logiem i ticketem;
- produkcja nieosiągalna z sandboxu Buildera;
- brak mountu `~/.ssh`, `~/.aws`, `~/.gh` i pełnego host HOME;
- brak Docker socket;
- audit każdej akcji mutującej.

---

## 14. Retry, budżety i circuit breakers

Per ticket:

```yaml
max_builder_attempts: 2
max_verify_attempts: 2
max_runtime_minutes: 45
max_parallel_builders: 1
max_diff_size: policy-defined
max_cost: project-defined
```

Zasady:

- retry po transient failure jest automatyczny;
- ten sam błąd dwa razy blokuje task;
- przekroczenie czasu, kosztu lub zakresu kończy run jako `blocked`;
- agent nie zwiększa sam własnego budżetu;
- czerwony CI nie może zostać zamieniony w zielony przez zmianę polityki;
- flaky retry służy diagnozie, nie ukrywaniu błędu;
- każda próba zapisuje outcome, log, koszt, commit i powód;
- task z brakiem heartbeatu lub martwym PID-em jest reclaimowany przez dispatcher;
- niejednoznaczny stan kończy się fail closed.

---

## 15. Audit trail i observability

Każdy ticket powinien mieć wspólny correlation ID:

```text
Linear issue ID ↔ Kanban parent task ID ↔ branch ↔ PR ↔ commit SHA
↔ Vercel deployment ID ↔ production release ID
```

Minimalny audyt:

- kto i kiedy aktywował ticket;
- payload i wersja workflow;
- routing i risk score;
- źródła Scouta;
- wersje planu;
- wszystkie runy agentów;
- użyty model/runtime;
- zmienione pliki;
- komendy testowe;
- wyniki CI i QA;
- komentarze i blokady;
- aprobaty człowieka;
- deployment URL i SHA;
- wynik smoke testu;
- rollback, jeśli wystąpił;
- koszt i czas każdego etapu.

Metryki operacyjne:

- lead time ticket → PR;
- czas oczekiwania na człowieka;
- first-pass QA rate;
- liczba iteracji Builder–Verifier;
- odsetek zablokowanych zadań;
- koszt per ticket i per typ;
- rollback rate;
- defect escape rate;
- agent-caused incidents;
- procent automatyzacji per risk class.

Powiadomienia Telegram:

- plan approval required;
- task blocked;
- circuit breaker/gave_up;
- PR ready for review;
- production approval required;
- deployment failed;
- rollback wykonany;
- przekroczony budżet.

---

## 16. Plan wdrożenia

### Faza 0 — polityki i kontrakty

Deliverables:

- wybór pierwszego repozytorium;
- mapowanie Linear team/project → repo;
- definicja `Ready for Agents`;
- risk matrix R0–R4;
- required GitHub checks;
- branch naming;
- format handoffów;
- zasady blokowania i eskalacji;
- wskazanie CODEOWNERS.

Exit criteria:

- żadna decyzja o uprawnieniach nie pozostaje implicit;
- testowy ticket ma kompletne AC;
- `main` jest chroniony.

### Faza 1 — pilot do draft PR-a

Zakres:

- jeden projekt/repo;
- jeden board Hermes powiązany z repo;
- pięć profili;
- stały DAG Scout → Planner → Builder → Verifier;
- Linear polling zamiast webhooka;
- worktree per ticket;
- Codex sandbox;
- draft PR;
- obowiązkowy human merge;
- brak automatycznej produkcji.

Exit criteria:

- trzy do pięciu syntetycznych ticketów przechodzi end-to-end;
- retry nie duplikuje pipeline’u;
- Verifier pracuje na czystym SHA;
- nie ma dostępu do `main` ani produkcji;
- wszystkie handoffy są widoczne w Kanbanie.

### Faza 2 — QA i Vercel Preview

Zakres:

- pełne GitHub Actions;
- Vercel Preview;
- Playwright/smoke;
- automatyczny raport w Linear i PR;
- risk-based plan gate;
- fix task po negatywnym review;
- koszt i czas per run;
- powiadomienia Telegram.

Exit criteria:

- pipeline zatrzymuje się na czerwonym checku;
- preview jest testowany przez Verifiera;
- max attempts działa;
- człowiek otrzymuje skondensowany approval packet.

### Faza 3 — kontenery i silniejsza izolacja

Zakres:

- efemeryczny kontener per worker run;
- isolated HOME;
- non-root i read-only rootfs;
- egress allowlist;
- per-run credentials;
- resource limits;
- brak dostępu do hostowych credentiali;
- automatyczne sprzątanie kontenerów.

Exit criteria:

- próba odczytu pliku poza workspace jest blokowana;
- próba połączenia z niezatwierdzonym hostem jest blokowana;
- worker nie widzi tokenów innej roli;
- po zakończeniu nie pozostają procesy i sekrety.

### Faza 4 — webhook i reconciliation

Zakres:

- Linear→Hermes bridge;
- HMAC i replay protection;
- trwała event queue;
- reconciliation cron;
- deduplikacja;
- obsługa zmian statusu, anulowania i unblock.

Exit criteria:

- duplikat delivery nie tworzy nowego tasku;
- opóźniony webhook nie cofa statusu;
- awaria bridge nie gubi ticketu;
- reconciler naprawia rozbieżność Linear/Kanban.

### Faza 5 — kontrolowana produkcja

Zakres:

- automatyczny deploy tylko R0–R1 po human merge;
- production gates R2–R4;
- smoke i monitoring;
- feature flags/canary;
- rollback;
- osobny migration runner.

Exit criteria:

- agent nie może sam zatwierdzić produkcji;
- wdrażany SHA odpowiada zweryfikowanemu PR;
- rollback jest przetestowany;
- Linear zamyka się dopiero po potwierdzeniu stabilności.

### Faza 6 — specjalizowane workflow

Dopiero po stabilnym pilocie:

- hotfix workflow;
- równoległe sandboxy „solution racing”;
- dynamiczny `kanban decompose`;
- frontend UX specialist;
- security reviewer;
- dependency update lane;
- automatyczny low-risk auto-merge jako świadoma, odwracalna polityka.

---

## 17. Test plan dla samej fabryki

### Intake

- poprawny ticket tworzy dokładnie jeden pipeline;
- niekompletny ticket przechodzi do `Needs Clarification`;
- duplikat eventu jest ignorowany;
- anulowanie ticketu zatrzymuje nieuruchomione etapy;
- nieznane repo blokuje workflow.

### Routing

- auth/billing/migration automatycznie podnoszą risk class;
- agent nie może obniżyć R3 do R1;
- chore nie uruchamia ciężkiego hotfix workflow;
- brak mapowania CODEOWNER blokuje sensitive task.

### Sandboxing

- Builder nie zapisze poza worktree;
- Scout nie wykona push;
- Verifier nie zmodyfikuje PR branch;
- worker nie odczyta hostowego HOME;
- worker nie połączy się z produkcyjną bazą;
- po crashu kontener jest niszczony;
- świeży verify checkout nie zawiera lokalnych plików Buildera.

### Workflow

- parent failure nie promuje child task;
- `blocked` wymaga jawnego unblock;
- crash jest wykrywany i task reclaimowany;
- po dwóch błędach działa circuit breaker;
- fix #2 otrzymuje feedback z Verify #1;
- completion bez structured handoff jest odrzucane przez policy.

### GitHub/CI

- direct push do `main` jest blokowany;
- czerwony required check blokuje merge;
- nowy push unieważnia stare approval;
- Verifier analizuje aktualne SHA;
- PR bez powiązanego Linear ID jest blokowany;
- zmiana poza zakresem podnosi flagę review.

### Deployment

- R1 wdraża się dopiero po human merge;
- R3 wymaga production approval;
- inny SHA niż zweryfikowany jest odrzucany;
- smoke failure uruchamia rollback/flag off;
- Linear nie przechodzi do Done przy failed deployment.

---

## 18. Otwarte decyzje

1. Które repozytorium będzie pilotem?
2. Jaki Linear team/project i status lub label będzie triggerem?
3. Czy trigger ma być statusem `Ready for Agents`, etykietą `agent:ready`, czy oboma?
4. Czy pierwszy pilot ma obejmować tylko chores i bugi R0–R1?
5. Czy plan ma wymagać akceptacji dla każdego feature’a, czy tylko R2+?
6. Które checks są obowiązkowe w pierwszym repo?
7. Czy Vercel Preview jest chronione i jak Verifier uzyska automation bypass?
8. Docker Desktop czy OrbStack na pilota?
9. Czy worker ma działać lokalnie na Macu, czy od razu na always-on Linux host?
10. Jaki budżet czasu i kosztu per ticket?
11. Czy Builder ma używać wyłącznie Codex App-Server Runtime, czy frontend może być routowany do Claude Code?
12. Kto jest CODEOWNER-em i production approverem dla pilota?
13. Jak długo zachowujemy worktrees, logi i artefakty?
14. Czy po udanym pilocie R0 może otrzymać auto-merge, czy human merge pozostaje bezwzględny?

---

## 19. Rekomendowany pierwszy pilot

Najbezpieczniejszy pierwszy krok:

- jedno niewrażliwe repozytorium;
- ticket typu mały bug lub chore;
- Linear trigger `Ready for Agents`;
- polling co minutę;
- pięć profili;
- deterministyczny DAG;
- worktree per ticket;
- świeży checkout Verifiera;
- Codex App-Server Runtime dla Buildera;
- GitHub draft PR;
- testy i Vercel Preview;
- obowiązkowy human merge;
- brak produkcyjnych credentiali;
- brak automatycznego deploymentu w pierwszych testach;
- trzy do pięciu kontrolowanych ticketów syntetycznych;
- przegląd wyników, kosztów i failure modes przed rozszerzeniem automatyzacji.

Kryterium sukcesu pilota:

> Ticket oznaczony jako `Ready for Agents` zostaje bez ręcznego prowadzenia przekształcony w zgodny z zakresem, przetestowany i niezależnie zweryfikowany draft PR z kompletnym raportem. System zatrzymuje się bezpiecznie przy niejasności, błędzie, przekroczeniu budżetu lub potrzebie decyzji człowieka.

---

## 20. Źródła

- Indie Dev Dan, „FORGET Loop Engineering. Agentic Engineering is about THIS”: https://www.youtube.com/watch?v=VQy50fuxI34&t=916s
- Hermes Kanban: https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban
- Hermes Kanban tutorial: https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-tutorial
- Hermes Kanban worker lanes: https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes
- Hermes Codex App-Server Runtime: https://hermes-agent.nousresearch.com/docs/user-guide/features/codex-app-server-runtime
- Hermes Webhooks: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks
- Hermes Profiles: https://hermes-agent.nousresearch.com/docs/user-guide/profiles
- Linear MCP: https://linear.app/docs/mcp
- Linear Webhooks: https://linear.app/developers/webhooks
- GitHub Protected Branches: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- Vercel Deployment Protection: https://vercel.com/docs/deployment-protection

---

## 21. Decyzja architektoniczna

Przyjęty kierunek:

1. Hermes Kanban jako trwały control plane.
2. Pięć wąskich profili zamiast jednego wszechmocnego agenta.
3. Stały DAG w pilocie zamiast swobodnego swarmu.
4. Linear jako system rekordowy ticketu.
5. GitHub PR i CI jako nieomijalna granica jakości.
6. Worktree per ticket oraz świeży checkout per weryfikacja.
7. Kontener per worker run jako docelowa granica bezpieczeństwa.
8. Człowiek przy aktywacji, merge i operacjach wysokiego ryzyka.
9. Automatyzacja rozszerzana stopniowo na podstawie danych z pilota.
10. Fail closed: przy niejasności system blokuje się i pyta, zamiast zgadywać.
