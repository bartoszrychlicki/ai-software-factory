# Flow ticketu w ai-factory

Diagram opisuje kod produkcyjny po refaktorze niezawodności. Linear steruje
przepływem przez jawne stany; komentarze są raportem lub payloadem ścisłych komend,
nie są interpretowane heurystycznie.

```mermaid
flowchart TD
    A["Linear: Todo"] --> B{"API Mastry zdrowe?<br/>breaker zamknięty?<br/>wolny slot projektu?"}
    B -- "nie" --> A
    B -- "tak" --> C["create-run w Mastrze"]
    C --> D["Claim w Linear + state.json"]
    D --> E["Trwały outbox: START"]
    E --> F["Intake: projects.yaml + routing.yaml"]

    F --> G["Planner"]
    G --> H{"Ścisły verdict planu"}
    H -- "blocked + pytania" --> I["Suspend: pytania do autora"]
    I --> J["Odpowiedź + stan Planowanie"]
    J --> K["Trwały outbox: RESUME clarify"]
    K --> G
    H -- "brak kontraktu / blocked bez pytań" --> X["BLOCKED w Linear"]
    H -- "ok: files + domain" --> L["Rezerwacja plików"]

    L --> M["Suspend: plan do akceptacji"]
    M --> N{"Decyzja człowieka"}
    N -- "odrzuć" --> X
    N -- "zatwierdź" --> O{"Kolizja zadeklarowanych plików?"}
    O -- "tak" --> O
    O -- "nie" --> P["Trwały outbox: RESUME approve-plan"]

    P --> Q["Builder w osobnym worktree"]
    Q --> QA{"Actual changed files ⊆ plan.files?"}
    QA -- "nie" --> Q
    QA -- "tak" --> R["Commit fabryki"]
    R --> S["Świeży detached checkout"]
    S --> T["Checks + e2e + acceptance verifier<br/>verifiedSha = SHA"]
    T -- "FAIL, próba < 2" --> Q
    T -- "FAIL po limicie" --> X
    T -- "PASS" --> U["Sync z origin/main"]

    U -- "nowy SHA" --> UA["Pełne checks/e2e + acceptance verifier<br/>verifiedSha = nowy SHA"]
    UA -- "FAIL / konflikt" --> X
    U -- "SHA bez zmian" --> V["Push + draft PR"]
    UA -- "PASS" --> V
    V --> VB["GitHub CI dla dokładnego PR head SHA"]
    VB -- "missing / pending / FAIL" --> VC["PR pozostaje draftem"]
    VB -- "PASS" --> W["Pełny diff PR: code review"]
    W -- "FIX, runda < 3" --> Y["Builder poprawia w zakresie plan.files"]
    Y --> YA["Nowy SHA: pełne checks/e2e + acceptance verifier"]
    YA -- "FAIL" --> VC
    YA -- "PASS" --> YB["Push + GitHub CI dla nowego SHA"]
    YB -- "FAIL" --> VC
    YB -- "PASS" --> W
    W -- "LGTM + sha = verifiedSha + CI PASS" --> Z["PR ready for review"]
    W -- "uwagi po limicie / review niedostępne" --> ZA["PR pozostaje draftem"]

    Z --> ZB{"Decyzja człowieka o PR"}
    ZA --> ZB
    ZB -- "PR zamknięty" --> ZC["Cleanup + ticket wraca do Todo"]
    ZB -- "PR zmergowany" --> ZD["Cleanup worktree/branch + Linear Done"]
    ZD --> ZE["Prod smoke z retry"]
    ZE -- "PASS / brak checks" --> ZF["Cykl domknięty"]
    ZE -- "FAIL" --> ZG["Linear: In Review + alarm"]

    subgraph Durability["Warstwa trwałości i recovery"]
      R1["runs/<ticket>/state.json<br/>fazy, bramki, outbox, PR, smoke"]
      R2["Mastra storage<br/>snapshot workflow"]
      R3["runs/<ticket>/<run>/*<br/>plan, approval, verify, review, screenshots"]
      R4["Restart pollera<br/>adopcja wszystkich unfinished runów"]
    end

    D -.-> R1
    E -.-> R1
    P -.-> R1
    F -.-> R2
    G -.-> R3
    T -.-> R3
    W -.-> R3
    R4 -.-> R1
    R4 -.-> R2
```

## Gwarancje i granice

1. Claim następuje dopiero po utworzeniu runu Mastry i zapisie lokalnego rejestru.
2. `start` i `resume-no-wait` są sprawdzane po HTTP. Błąd transportu pozostawia
   komendę jako `pending`; kolejny tick lub restart ponawia ją. Snapshot potwierdza
   dalszy postęp runu.
3. Poller odzyskuje wszystkie niezakończone runy z `state.json`; nie rekonstruuje
   kluczowego stanu z tekstu komentarzy.
4. Końcowy stan Lineara (`Done`, `Canceled`, `Duplicate`) zatrzymuje aktywny run,
   więc silniki nie pracują po anulowaniu ticketu.
5. Werdykty agentów są fail-closed, ale checks, Git, status PR i prod smoke są
   wyznaczane przez kod deterministyczny.
6. Fabryka nie wykonuje automatycznego merge. Merge watcher obsługuje skutki
   decyzji człowieka i powtarza prod smoke po restarcie, jeśli nie został zapisany.
7. Każda zmiana SHA unieważnia `verifiedSha`; publikacja i zdjęcie draftu wymagają
   pełnych checks/e2e, acceptance verification oraz GitHub CI dla dokładnego head SHA.
8. Projekt bez deterministycznych `checks` lub GitHub `ci.requiredChecks` jest
   odrzucany przy intake. Zmiany buildera i remediation muszą mieścić się w
   zatwierdzonym `factory.files`.
