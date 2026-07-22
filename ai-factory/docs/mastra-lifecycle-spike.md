# BAR-157 — wynik strict spike'a trwałości Mastry

Data: 2026-07-22

Wersje: `@mastra/core 1.51.0`, `@mastra/libsql 1.16.0`, `mastra 1.19.0`

Warunek: wyłącznie publiczne API Mastry, bez `workflow-persistence-patch.ts`

## Decyzja

**Mastra nie zostaje właścicielem lifecycle ticketu.** Wdrażamy własny,
transakcyjny coordinator oparty o SQLite. Mastra pozostaje executorem workflowów
i agentów, wywoływanym przez transactional outbox coordinatora.

To jest bezpośrednie zastosowanie binarnej bramki z ADR: co najmniej jeden
scenariusz krytyczny nie przeszedł, więc wariant „Mastra jako lifecycle owner”
został odrzucony. Nie wybieramy hybrydy z kilkoma równoległymi właścicielami.

## Macierz wyników

| Scenariusz | Wynik | Dowód / obserwacja |
| --- | --- | --- |
| Suspend w procesie A, resume w procesie B | PASS | Snapshot `suspended` został odczytany z LibSQL, a publiczne `resume()` zakończyło run |
| Crash przed efektem, publiczne `restart()` | PASS | Run miał stan `running`, restart wykonał mockowany efekt dokładnie raz |
| Crash po efekcie, przed checkpointem kroku | **FAIL** | `restart()` wykonał efekt drugi raz; licznik efektów: 2 |
| Dwie równoległe dostawy tej samej komendy resume | **FAIL** | Obie dostawy zakończyły się sukcesem i obie wykonały efekt; licznik: 2 |
| Replay jako nowy powiązany run | PASS warunkowy | Nowy `runId` działa, lecz relację `parentRunId` musi utrzymywać nasza domena |
| Deduplikacja tego samego eventu | **FAIL / brak mechanizmu domenowego** | Publiczny workflow Mastry nie dostarcza inboxu z kluczem idempotencji dla eventów aplikacji |
| Restart po zapisie outboxu, przed efektem | **FAIL / brak atomowości domenowej** | Snapshot Mastry i aplikacyjny outbox nie są jedną transakcją |

Testy wykonują realny restart granicy procesu. Worker jest zabijany sygnałem
`SIGKILL`, a nowy runtime otwiera ten sam plik LibSQL i używa publicznych
`createRun({ runId })`, `resume()` oraz `restart()`.

## Dlaczego pozytywny suspend/resume nie wystarcza

Mastra potrafi trwale zapisać przebieg workflow. Nie może jednak atomowo zapisać
checkpointu razem z efektem wykonanym w Linearze, GitHubie lub przez agenta.
Istnieje nieusuwalne okno między „efekt już nastąpił” i „Mastra potwierdziła
krok”. Restart w tym oknie poprawnie powtarza krok, ale z perspektywy produktu
tworzy drugi komentarz, PR albo zmianę statusu.

Idempotentny adapter może ograniczyć część ryzyka, lecz sam nie rozwiązuje
deduplikacji komend, inboxu, audytu przejść i atomowego zapisu intencji efektu.
Te gwarancje muszą należeć do jednego coordinatora i jednej transakcji SQLite.

## Konsekwencje implementacyjne

1. Własny coordinator jest jedynym komponentem wykonującym przejścia lifecycle.
2. SQLite przechowuje bieżący stan, append-only transitions, commands, inbox,
   outbox i klucze idempotencji w jednej granicy transakcji.
3. Mastra otrzymuje idempotentne zlecenia z outboxu i zwraca fakty do inboxu;
   jej snapshot nie steruje bezpośrednio statusem biznesowym ticketu.
4. Linear pozostaje projekcją i wejściem komend operatora, a GitHub źródłem
   faktów o PR/CI.
5. Legacy `workflow-persistence-patch.ts` pozostaje wyłącznie do czasu cutoveru
   istniejącego pipeline'u. Nie jest częścią nowego modelu i musi zniknąć wraz
   z wyłączeniem legacy ownera.

## Uruchomienie dowodu

```shell
node --import tsx --test --test-concurrency=1 \
  src/tests/mastra-durability-spike.test.ts
```

Charakterystyki oznaczone `CHARACTERIZATION` są testami regresyjnymi negatywnej
zdolności: test przechodzi, gdy odtwarza zaobserwowane podwojenie efektu. Ich
celem jest ochrona decyzji architektonicznej przed przypadkowym „cofnięciem” bez
ponownego, jawnego przejścia całej bramki na nowej wersji Mastry.
