/**
 * Poller Linear → ticket-pipeline.
 *
 * Pętla co INTERVAL:
 *  1) health-check API Mastry (serwer w dole = nie claimujemy, tickety czekają),
 *  2) tickety z labelem `agent:ready` (backlog/todo) → claim → run → opiekun,
 *  3) merge-watcher: tickety „In Review" z PR-em fabryki → po merge'u Done +
 *     sprzątnięcie worktree/gałęzi + ff-pull lokalnego maina; PR zamknięty bez
 *     merge'a → Todo z komentarzem.
 * Na starcie: adopcja sierot — tickety „In Progress" z runId w komentarzach
 * odzyskują opiekuna po restarcie pollera.
 *
 * STEROWANIE = PRZEJŚCIA STANÓW (BAR-142): claim `Backlog → Todo`, aprobata
 * `👤 🚦 Plan do akceptacji → 🔨 Build`, odrzucenie `→ Backlog/Canceled/⛔`,
 * odpowiedzi `👤 ❓ Pytania → 🧠 Planowanie`. Furtka z telefonu: ścisłe komendy
 * `/approve`, `/reject <powód>`, `/answer <treść>`. Żaden regex na swobodnym
 * tekście nie decyduje o przepływie — komentarze są wyłącznie danymi.
 *
 * Uruchomienie:  npx tsx src/sources/poll-linear.ts [--once]
 * Produkcyjnie: usługa launchd (ops/install-launchd.sh).
 * Wymaga: LINEAR_API_KEY (env lub .env), działającego `mastra dev`.
 * Idempotencja: marker `[linear:<ISSUE>:v1]` w komentarzach + zdjęcie labela.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { LinearSource } from "./linear";
import { getProject } from "../pipeline/projects";
import { breakerOpen, recordRunOutcome, checkHourlySpend } from "../pipeline/breaker";
import { notify } from "../pipeline/notify";
import { runProdChecks } from "../pipeline/prod-smoke";
import * as registry from "../pipeline/run-registry";
import { LINEAR_STATE_MAP as MAP, phaseOfState, decisionOfState } from "./state-map";
import { parseCommand, hintFor } from "./commands";

const exec = promisify(execFile);

// timestampy w logach (debugowanie „kiedy to się stało" bolało przy każdym incydencie)
for (const level of ["log", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => orig(new Date().toISOString().slice(11, 19), ...args);
}

// --- konfiguracja ---------------------------------------------------------

loadDotEnv();
const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) {
  console.error("Brak LINEAR_API_KEY (env lub ai-factory/.env)");
  process.exit(1);
}
// lista projektów: LINEAR_PROJECTS=pilot-app,br-budget (nazwa w Linear == klucz w projects.yaml)
const PROJECTS = (process.env.LINEAR_PROJECTS ?? process.env.LINEAR_PROJECT ?? "pilot-app")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FACTORY_API = process.env.FACTORY_API ?? "http://localhost:4111/api";
const WORKFLOW = "ticketPipeline";
const WORKTREES_ROOT = process.env.FACTORY_WORKTREES ?? join(homedir(), ".ai-factory", "worktrees");
const POLL_INTERVAL_MS = 60_000;
const RUN_WATCH_INTERVAL_MS = 20_000;
const RUN_WATCH_MAX_MS = 24 * 60 * 60_000; // human gate może czekać długo

const sources = PROJECTS.map((project) => ({ project, src: new LinearSource(API_KEY!, project) }));
const active = new Set<string>(); // tickety z opiekunem w tym procesie
const mergeHandled = new Set<string>(); // merge obsłużony w tym procesie (stan trwały i tak jest w Linear)
let breakerLogged = false; // log otwarcia bezpiecznika raz na zmianę stanu, nie co cykl
const limitLogged = new Set<string>(); // log limitu równoległości raz na projekt, nie co cykl

const marker = (id: string) => `[linear:${id}:v1]`;

/** Fabryka jako jedyny autor stanów procesu (projekty z statuses: extended w projects.yaml). */
/** Ustawia fazę fabryki. Nigdy nie nadpisuje stanów końcowych (BAR-127). */
async function setPhase(project: string, src: LinearSource, id: string, phase: registry.FactoryPhase, runId?: string): Promise<void> {
  try {
    const stateName = MAP.phases[phase];
    const rid = runId ?? registry.readState(id)?.runId;
    if (rid) registry.recordPhase(id, { project, runId: rid }, phase, stateName);
    const cfg = await getProject(project);
    if (cfg.statuses !== "extended") return;
    const current = await src.getStateName(id).catch(() => undefined);
    if (current && MAP.terminal.includes(current)) {
      console.log(`[${id}] pomijam fazę ${phase} — ticket w stanie końcowym (${current})`);
      return;
    }
    await src.setStateByName(id, stateName);
  } catch (err) {
    console.error(`[${id}] setPhase(${phase}) nieudane:`, err instanceof Error ? err.message : err);
  }
}

// --- główna pętla ---------------------------------------------------------

const once = process.argv.includes("--once");

async function main() {
  await adoptOrphans().catch((err) => console.error("Adopcja sierot nieudana:", err));

  do {
    try {
      if (!(await serverUp())) {
        console.error("API Mastry nie odpowiada — pomijam cykl (tickety poczekają z labelem)");
      } else {
        await checkHourlySpend().catch(() => {});
        const breakerReason = await breakerOpen().catch(() => null);
        if (breakerReason) {
          if (!breakerLogged) {
            console.error(`🔌 CIRCUIT BREAKER OTWARTY — nie podejmuję nowych ticketów: ${breakerReason}`);
            notify("🔌 Fabryka: circuit breaker otwarty", breakerReason).catch(() => {});
            breakerLogged = true;
          }
        } else {
          breakerLogged = false;
          for (const { project, src } of sources) {
            const tickets = await src.listReady().catch((err) => {
              console.error(`[${project}] listReady nieudane:`, err instanceof Error ? err.message : err);
              return [];
            });
            if (!tickets.length) continue;

            // BAR-122: limit równoległości per projekt — nadmiar ticketów budowanych naraz
            // rozjeżdża maina i kończy się konfliktami (noc 2026-07-22: 6 skonfliktowanych PR-ów)
            const cfg = await getProject(project).catch(() => undefined);
            const limit = cfg?.max_concurrent_tickets;
            let free = Number.POSITIVE_INFINITY;
            if (limit !== undefined) {
              const inFlight = await src.countActive().catch(() => 0);
              free = Math.max(0, limit - inFlight);
              if (free === 0) {
                if (!limitLogged.has(project)) {
                  console.log(`[${project}] limit równoległości ${limit} osiągnięty (${inFlight} w toku) — ${tickets.length} ticket(ów) czeka z labelem`);
                  limitLogged.add(project);
                }
                continue;
              }
              limitLogged.delete(project);
            }

            for (const t of tickets) {
              if (active.has(t.id)) continue;
              if (free <= 0) break;
              free -= 1;
              active.add(t.id);
              // fire-and-forget: każdy ticket żyje własnym cyklem, pętla polluje dalej
              handleTicket(project, src, t.id, t.title, t.description, t.labels).catch((err) => {
                console.error(`[${t.id}] nieobsłużony błąd:`, err);
                active.delete(t.id);
              });
            }
          }
        }
        // merge-watcher i adopcja działają też przy otwartym bezpieczniku — one nie zużywają silników
        await watchMerges().catch((err) => console.error("Merge-watcher nieudany:", err));
        // adopcja w KAŻDYM cyklu (idempotentna — active/finalized guardy): jednorazowa przy starcie
        // padała na czkawce API Lineara i zostawiała runy bez opiekuna (BAR-104, 2026-07-21)
        await adoptOrphans().catch((err) => console.error("Adopcja sierot nieudana:", err));
      }
    } catch (err) {
      console.error("Poll nieudany:", err instanceof Error ? err.message : err);
    }
    if (!once) await sleep(POLL_INTERVAL_MS);
  } while (!once);

  // --once: daj dokończyć wystartowanym ticketom zanim proces umrze
  while (active.size > 0) await sleep(5_000);
}

async function handleTicket(
  project: string,
  src: LinearSource,
  id: string,
  title: string,
  description: string,
  labels: string[]
) {
  console.log(`[${id}] claim (${project}): ${title}`);
  const reusePlan = await findReusablePlan(src, id, description);
  await src.claim(id);
  await src.comment(id, reusePlan
    ? `🤖 ai-factory przyjęła ticket ${marker(id)}. ♻️ Reużywam zatwierdzonego planu z poprzedniego runu (porażka infra/budżet) — build startuje od razu, bez bramki.`
    : `🤖 ai-factory przyjęła ticket ${marker(id)}. Planner startuje.`);
  notify(`🤖 ${id}: ticket przyjęty`, reusePlan ? "♻️ Reuse zatwierdzonego planu — build od razu." : `Planner startuje (${project}). Plan przyjdzie do akceptacji.`).catch(() => {});

  const runId = await createRun();
  // rejestr: manifest zlecenia czytany RAZ przy claimie (labele = parametry, nie sygnały)
  registry.updateState(id, { project, runId }, (st) => {
    st.manifest = {
      labels,
      engine: labels.find((l) => l.startsWith("engine:"))?.slice(7),
      domain: labels.find((l) => l.startsWith("domain:"))?.slice(7),
      planMode: labels.find((l) => l.startsWith("plan:"))?.slice(5),
    };
  });
  await setPhase(project, src, id, reusePlan ? "build" : "planning", runId);
  await src.comment(id, `🧾 run \`${runId}\` ${marker(id)}`).catch(() => {}); // kotwica adopcji (kluczowa dla reuse — nie ma komentarza z planem)
  fireStart(runId, { id, title, description, project, labels, reusePlan });
  console.log(`[${id}] run ${runId} wystartowany`);
  await watchRun(project, src, id, runId);
}

/**
 * Opiekun runa: komentuje plan, nasłuchuje ludzkiej decyzji w Linear,
 * raportuje finał. planCommentedAtInit ≠ undefined = adopcja (plan już
 * skomentowany przed restartem pollera).
 */
async function watchRun(
  project: string,
  src: LinearSource,
  id: string,
  runId: string,
  planCommentedAtInit?: string,
  decisionSentInit = false
) {
  let planCommentedAt = planCommentedAtInit;
  let decisionSent = decisionSentInit;
  let hintSent = false;
  const deadline = Date.now() + RUN_WATCH_MAX_MS;

  // fazy śledzimy po ARTEFAKTACH (snapshot Mastry po resume jest stale — bug guarda, patrz CLAUDE.md);
  // przy adopcji seedujemy istniejącymi plikami, żeby nie odgrywać starych kamieni milowych
  const runDir = join(process.cwd(), "runs", id, runId);
  const seenArtifacts = new Set<string>(safeReaddir(runDir));
  const answeredRounds = new Set<number>(); // rundy pytań, dla których resume już poszedł
  const answeredFallback = new Set<number>(); // drugi strzał z pełną ścieżką kroku (format id w zagnieżdżonym workflow)
  const hintedRounds = new Set<number>(); // podpowiedź „jak zatwierdzić odpowiedzi" raz na rundę

  try {
    while (Date.now() < deadline) {
      await sleep(RUN_WATCH_INTERVAL_MS);
      await notifyPhaseMilestones(project, src, id, runDir, seenArtifacts);
      const run = await getRun(runId).catch(() => undefined);
      if (!run) continue; // serwer chwilowo w dole — czekamy, run w Mastrze nie znika
      const status = runStatus(run);

      // tryb dopytywania: suspend na clarify-ticket obsługujemy PRZED przepływem aprobaty
      if (status === "suspended" && await handleClarifySuspend(project, src, id, runId, runDir, answeredRounds, answeredFallback, hintedRounds)) {
        continue;
      }

      if (status === "suspended" && !planCommentedAt) {
        const plan = findString(run, "plan") ?? artifactBody(join(runDir, "plan.md")) ?? "(nie udało się odczytać planu z runa)";
        try {
          await src.comment(
            id,
            `📋 Plan gotowy ${marker(id)} — czeka na Twoją decyzję.\n\n` +
              `**Przeciągnij kartę:** na *${MAP.phases.build}* — buduję, albo na *Backlog / Canceled* — odrzucam (powód w komentarzu).\n` +
              `Z telefonu: komenda \`/approve\` albo \`/reject <powód>\`.\n\n---\n\n${clip(plan, 16000)}`
          );
          planCommentedAt = new Date().toISOString(); // dopiero PO udanym komentarzu — inaczej czkawka API gubi plan na zawsze (BAR-104)
          registry.openGateRecord(id, { project, runId }, "plan-approval", 0, "🚦 Plan do akceptacji");
          await setPhase(project, src, id, "plan-approval", runId);
          console.log(`[${id}] plan czeka na decyzję w Linear`);
          notify(`⏳ ${id}: plan do akceptacji`, `Przeciągnij kartę na „${MAP.phases.build}" albo napisz /approve.`).catch(() => {});
        } catch (err) {
          console.error(`[${id}] komentarz z planem nieudany (retry w następnym ticku):`, err instanceof Error ? err.message : err);
        }
      } else if (status === "suspended" && planCommentedAt && !decisionSent) {
        // 1) KANONICZNIE: przejście stanu (przeciągnięcie karty) wg mapy decyzji
        const state = await src.getStateName(id).catch(() => undefined);
        let kind = state ? decisionOfState(MAP, "plan-approval", state) : undefined;
        let via: "state" | "command" = "state";
        // 2) FURTKA: ścisła komenda w komentarzu (`/approve`, `/reject <powód>`)
        const cmd = kind ? undefined : await readCommandDecision(src, id, planCommentedAt);
        if (!kind && cmd?.decision) {
          kind = cmd.decision.kind;
          via = "command";
        }
        // 3) komentarz bez sygnału przy otwartej bramce → jednorazowa podpowiedź (koniec cichych porażek)
        if (!kind && cmd?.strayComment && !hintSent) {
          hintSent = true;
          await src.comment(id, `${hintFor("plan-approval", { approve: MAP.decisions["plan-approval"]?.approve?.[0] })} ${marker(id)}`).catch(() => {});
        }
        const decision = kind === "approve"
          ? { approved: true }
          : kind === "reject"
            ? { approved: false, feedback: cmd?.decision?.payload ?? (await collectPayload(src, id, planCommentedAt)) ?? "odrzucone bez powodu" }
            : undefined;
        if (decision) {
          decisionSent = true;
          registry.recordDecision(id, { project, runId }, "plan-approval", 0, {
            kind: decision.approved ? "approve" : "reject",
            payload: decision.feedback,
            via,
            observedAt: new Date().toISOString(),
          });
          registry.markDecisionStep(id, { project, runId }, "plan-approval", 0, "consumedAt");
          fireResume(runId, decision);
          registry.markDecisionStep(id, { project, runId }, "plan-approval", 0, "resumeSentAt");
          console.log(`[${id}] decyzja z Linear: ${decision.approved ? "ZATWIERDZONO" : "ODRZUCONO"}`);
          // natychmiastowe domknięcie pętli zwrotnej — bez tego wygląda, jakby system nie chwycił decyzji
          if (decision.approved) {
            await src.comment(id, `🔨 Aprobata przyjęta ${marker(id)} — build ruszył. Kolejne kroki: verify (checks+testy+e2e) → PR.`).catch(() => {});
            await setPhase(project, src, id, "build", runId);
            notify(`🔨 ${id}: build ruszył`, "Aprobata planu przyjęta.").catch(() => {});
          } else {
            await src.comment(id, `↩️ Odrzucenie przyjęte ${marker(id)} — run zostanie zakończony, powód trafi do raportu.`).catch(() => {});
          }
        }
      }

      if (status === "success") {
        try {
        const prUrl = findString(run, "prUrl") ?? "(brak URL PR)";
        const review = findString(run, "reviewSummary") ?? "";
        // werdykt z result runa — findString by tu zawiódł (bierze najdłuższy string, a "pending" > "lgtm")
        const verdict = (run as { result?: { reviewVerdict?: string } }).result?.reviewVerdict;
        const reviewLine =
          verdict === "lgtm" ? "AI review: LGTM — PR oznaczony jako **ready for review**."
          : verdict === "fix" ? "⚠️ AI review: uwagi pozostały po wyczerpaniu rund review→fix — PR zostaje draftem, oceń przy merge."
          : "AI review (doradczo); PR zostaje draftem:";
        const screenshotMd = await uploadScreenshot(src, id, runId);
        await src.comment(
          id,
          `✅ Zbudowane i zweryfikowane ${marker(id)}. PR: ${prUrl}\n\n` +
            `${reviewLine}\n\n${clip(review, 4000)}${screenshotMd}\n\nMerge = decyzja człowieka.`
        );
        await src.setStatus(id, "human_review");
        registry.updateState(id, { project, runId }, (st) => { st.prUrl = prUrl; });
        registry.finalize(id, { project, runId }, "success");
        await setPhase(project, src, id, "pr-ready", runId);
        await recordRunOutcome(true).catch(() => {});
        notify(`✅ ${id}: PR gotowy`, `${prUrl}${verdict === "lgtm" ? " (ready for review)" : " (draft)"}`).catch(() => {});
        console.log(`[${id}] SUKCES → ${prUrl}`);
        break;
        } catch (err) {
          console.error(`[${id}] finał SUKCES nieudany (retry w następnym ticku):`, err instanceof Error ? err.message : err);
        }
      }

      if (status === "failed") {
        try {
        const msg = errorMessage(run);
        const blocked = /BLOCKED|odrzucony/i.test(msg);
        // serii bezpiecznika NIE nabijają: odrzucenie planu przez człowieka ani poprawny
        // BLOCKED na bramce planu (tani, pożądany fail-closed — np. ticket już zrobiony,
        // pytania do autora); liczą się porażki wykonania (verify FAIL po próbach, infra, budżet)
        const planGateBlocked = /plan bez PLAN: OK|niejasności blokujące|Pytania do autora|JUŻ ISTNIEJE|już istnieje/i.test(msg);
        if (!/odrzucony przez człowieka/i.test(msg) && !planGateBlocked) await recordRunOutcome(false).catch(() => {});

        // porażka INFRASTRUKTURALNA (nie-BLOCKED: timeout/spawn/silnik) → auto-retry dokładnie raz;
        // merytoryczny BLOCKED zawsze czeka na człowieka (retry bez zmiany wejścia = te same pytania za te same tokeny)
        if (!blocked) {
          const st = registry.readState(id);
          const alreadyRetried = st?.runId === runId
            ? st.autoRetry.count > 0
            : (await src.listComments(id).catch(() => [])).some((c) => c.body.includes("[auto-retry]"));
          if (!alreadyRetried) {
            registry.updateState(id, { project, runId }, (st) => { st.autoRetry = { count: st.autoRetry.count + 1, lastAt: new Date().toISOString() }; });
            await src.comment(id, `🔁 Porażka infrastrukturalna — auto-retry 1/1 [auto-retry] ${marker(id)}\n\n${clip(msg, 2000)}`);
            await src.setStatus(id, "needs_clarification"); // Todo — listReady wymaga stanu backlog/unstarted
            await src.relabelReady(id);
            console.log(`[${id}] FAILED (infra) → AUTO-RETRY`);
            break;
          }
        }

        await src.comment(
          id,
          `${blocked ? "🛑 BLOCKED" : "❌ Run nieudany (auto-retry wyczerpany)"} ${marker(id)}\n\n${clip(msg, 6000)}\n\n` +
            `Uzupełnij ticket i nadaj ponownie label \`agent:ready\`, żeby fabryka spróbowała jeszcze raz.`
        );
        await setPhase(project, src, id, "blocked", runId);
        registry.finalize(id, { project, runId }, /odrzucony przez człowieka/i.test(msg) ? "rejected" : blocked ? "blocked" : "failed");
        notify(`🛑 ${id}: ${blocked ? "BLOCKED — pytania w tickecie" : "run nieudany"}`, clip(msg, 180)).catch(() => {});
        console.log(`[${id}] FAILED${blocked ? " (BLOCKED)" : ""}`);
        break;
        } catch (err) {
          console.error(`[${id}] finał FAILED nieudany (retry w następnym ticku):`, err instanceof Error ? err.message : err);
        }
      }
    }
  } finally {
    active.delete(id);
  }
}

// --- adopcja sierot po restarcie pollera ----------------------------------

async function adoptOrphans() {
  // ŹRÓDŁO PRAWDY: rejestr runów (state.json). Deterministyczne, niezależne od
  // treści komentarzy i od historii poprzednich runów tego samego ticketu.
  for (const st of registry.listUnfinished()) {
    if (active.has(st.ticketId)) continue;
    const entry = sources.find((x) => x.project === st.project);
    if (!entry || !st.runId) continue;
    const gates = Object.values(st.gates);
    const openGate = gates.find((g) => g.decision === undefined);
    const pendingResume = gates.find((g) => g.decision && !g.decision.resumeSentAt);
    active.add(st.ticketId);
    console.log(
      `[${st.ticketId}] ADOPCJA z rejestru: run ${st.runId}, faza ${st.phase ?? "?"}` +
        (openGate ? `, bramka ${openGate.kind} otwarta` : pendingResume ? `, decyzja bez resume` : ", decyzje obsłużone")
    );
    watchRun(st.project, entry.src, st.ticketId, st.runId, openGate?.openedAt, !openGate && !pendingResume).catch((err) => {
      console.error(`[${st.ticketId}] adopcja padła:`, err);
      active.delete(st.ticketId);
    });
  }

  // FALLBACK (runy sprzed migracji, bez state.json): stare guardy tekstowe
  for (const { project, src } of sources) {
  const issues = await src.listWithComments("In Progress");
  for (const issue of issues) {
    if (active.has(issue.id)) continue;
    if (registry.readState(issue.id)?.runId) continue; // rejestr już to obsłużył
    const mine = issue.comments.filter((c) => c.body.includes(marker(issue.id)));
    if (mine.length === 0) continue; // nie nasz ticket
    // runId z najnowszego komentarza z planem (zawiera "run `<uuid>`")
    const runId = mine
      .map((c) => c.body.match(/run `([0-9a-f-]{36})`/)?.[1])
      .filter(Boolean)
      .pop();
    if (!runId) continue;
    const finalized = mine.some((c) =>
      c.body.includes("Zbudowane i zweryfikowane") || c.body.includes("🛑 BLOCKED") || c.body.includes("Run nieudany"));
    if (finalized) continue; // run zakończony przed restartem — nie dublujemy finału
    const planComment = mine.filter((c) => c.body.includes("Plan gotowy")).pop();
    // decyzja obsłużona przed restartem → NIE strzelamy resume drugi raz (BAR-104: ponowny
    // resume zdublował egzekucję Mastry i podwoił spalanie budżetu)
    const decisionHandled = mine.some((c) =>
      c.body.includes("Aprobata przyjęta") || c.body.includes("Odrzucenie przyjęte"));
    active.add(issue.id);
    console.log(`[${issue.id}] ADOPCJA sieroconego runa ${runId}${decisionHandled ? " (decyzja już obsłużona)" : ""}`);
    watchRun(project, src, issue.id, runId, planComment?.createdAt, decisionHandled).catch((err) => {
      console.error(`[${issue.id}] adopcja padła:`, err);
      active.delete(issue.id);
    });
  }
  }
}

// --- merge-watcher: domknięcie cyklu ticketu ------------------------------

async function watchMerges() {
  for (const { project, src } of sources) {
  // "Done" też: integracja Linear↔GitHub przestawia status natychmiast po merge'u i wygrywa
  // wyścig z watcherem — ticket znika z "In Review" zanim zdążymy posprzątać (BAR-91/92)
  // stany procesu (statuses: extended) — ticket po publish siedzi w "✅ PR do merge", nie w "In Review";
  // bez tego merge-watcher nigdy nie zobaczy zmergowanego PR-a (bug wykryty 2026-07-22)
  for (const state of ["In Review", "✅ PR do merge", "👀 Code review", "Done"] as const) {
  const issues = await src.listWithComments(state);
  for (const issue of issues) {
    if (mergeHandled.has(issue.id)) continue;
    const mine = issue.comments.filter((c) => c.body.includes(marker(issue.id)));
    const prUrl = mine
      .map((c) => c.body.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0])
      .filter(Boolean)
      .pop();
    if (!prUrl) continue;

    // ticket już Done (integracja) — nasza rola to tylko dosprzątanie, o ile worktree jeszcze istnieje
    if (state === "Done") {
      const project_ = await getProject(project).catch(() => undefined);
      if (!project_ || !existsSync(join(WORKTREES_ROOT, basename(project_.repo), issue.id))) continue;
    }

    let pr: { state: string; headRefName: string };
    try {
      const { stdout } = await exec("gh", ["pr", "view", prUrl, "--json", "state,headRefName"], { timeout: 30_000 });
      pr = JSON.parse(stdout);
    } catch {
      continue; // gh chwilowo nie działa — spróbujemy w kolejnym cyklu
    }

    if (pr.state === "MERGED") {
      mergeHandled.add(issue.id);
      await cleanupAfterMerge(project, issue.id, pr.headRefName);
      if (state === "In Review") {
        await src.comment(issue.id, `🎉 PR zmergowany ${marker(issue.id)} — ticket zamknięty, workspace posprzątany.`);
        await src.setStatus(issue.id, "done");
      }
      registry.updateState(issue.id, { project, runId: registry.readState(issue.id)?.runId ?? "" }, (st) => { st.mergeHandledAt = new Date().toISOString(); });
      console.log(`[${issue.id}] MERGED → Done${state === "Done" ? " (dosprzątanie po integracji)" : ""}`);
      prodSmokeGuard(project, src, issue.id).catch((err) =>
        console.error(`[${issue.id}] prod smoke padł:`, err instanceof Error ? err.message : err));
    } else if (pr.state === "CLOSED" && state === "In Review") {
      mergeHandled.add(issue.id);
      await cleanupAfterMerge(project, issue.id, pr.headRefName);
      await src.comment(
        issue.id,
        `↩️ PR zamknięty bez merge'a ${marker(issue.id)} — ticket wraca do Todo. ` +
          `Uzupełnij wymagania i nadaj label \`agent:ready\`, żeby spróbować ponownie.`
      );
      await src.setStatus(issue.id, "needs_clarification");
      console.log(`[${issue.id}] PR CLOSED → Todo`);
    }
  }
  }
  }
}

/** Worktree + lokalna gałąź po zmergowanym/zamkniętym PR + ff-pull maina (lekcja z TEST-4). */
async function cleanupAfterMerge(projectKey: string, ticketId: string, branch: string) {
  try {
    const project = await getProject(projectKey);
    const repo = project.repo;
    const wt = join(WORKTREES_ROOT, basename(repo), ticketId);
    await exec("git", ["-C", repo, "worktree", "remove", "--force", wt]).catch(() => {});
    await rm(wt, { recursive: true, force: true }).catch(() => {});
    await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
    await exec("git", ["-C", repo, "branch", "-D", branch]).catch(() => {});

    // lokalny main w tyle za originem już raz zepsuł nam precondition ticketu
    const def = project.default_branch ?? "main";
    const { stdout: cur } = await exec("git", ["-C", repo, "branch", "--show-current"]);
    const { stdout: dirty } = await exec("git", ["-C", repo, "status", "--porcelain"]);
    if (cur.trim() === def && dirty.trim() === "") {
      await exec("git", ["-C", repo, "fetch", "origin"]);
      await exec("git", ["-C", repo, "merge", "--ff-only", `origin/${def}`]);
      console.log(`[${ticketId}] lokalny ${def} zaktualizowany do origin`);
    } else {
      console.log(`[${ticketId}] pomijam pull ${def} (checkout: ${cur.trim() || "?"}, brudny: ${dirty.trim() !== ""})`);
    }
  } catch (err) {
    console.error(`[${ticketId}] sprzątanie po merge nieudane:`, err instanceof Error ? err.message : err);
  }
}

// --- powiadomienia o fazach (artefakty jako sygnał postępu) ----------------

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Nagłówek YAML artefaktu → wartość pola (outcome/verdict). */
function artifactField(path: string, field: string): string {
  try {
    const head = readFileSync(path, "utf8").slice(0, 600);
    return head.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Nowy artefakt = zakończona faza → notyfikacja z werdyktem (+ stan procesu na tablicy). */
async function notifyPhaseMilestones(project: string, src: LinearSource, id: string, runDir: string, seen: Set<string>) {
  for (const f of safeReaddir(runDir)) {
    if (seen.has(f)) continue;
    seen.add(f);
    const p = join(runDir, f);
    let msg: [string, string] | undefined;

    const build = f.match(/^build-attempt-(\d+)\.md$/);
    const verify = f.match(/^verify-attempt-(\d+)\.md$/);
    const review = f.match(/^review-round-(\d+)\.md$/);
    const fix = f.match(/^fix-round-(\d+)\.md$/);

    if (build) {
      const outcome = artifactField(p, "outcome");
      msg = outcome === "committed"
        ? [`🧱 ${id}: build gotowy (próba ${build[1]})`, "Verify startuje: checks + testy + e2e."]
        : [`⚠️ ${id}: build nieudany (próba ${build[1]})`, `Wynik: ${outcome || "?"} — pętla decyduje o retry.`];
      if (outcome === "committed") await setPhase(project, src, id, "verify");
    } else if (verify) {
      const outcome = artifactField(p, "outcome");
      msg = outcome === "pass"
        ? [`🧪 ${id}: verify PASS (próba ${verify[1]})`, "Publikacja PR i code review."]
        : [`🧪 ${id}: verify FAIL (próba ${verify[1]})`, `Wynik: ${outcome || "fail"} — feedback wraca do buildera.`];
      if (outcome === "pass") await setPhase(project, src, id, "review");
      else await setPhase(project, src, id, "build");
    } else if (review) {
      const verdict = artifactField(p, "verdict");
      msg = verdict === "lgtm"
        ? [`👀 ${id}: review LGTM (runda ${review[1]})`, "PR wychodzi z drafta."]
        : [`👀 ${id}: review FIX (runda ${review[1]})`, "Builder poprawia uwagi."];
    } else if (fix) {
      const outcome = artifactField(p, "outcome");
      if (outcome === "pushed") msg = [`🔧 ${id}: poprawki wgrane (runda ${fix[1]})`, "Kolejna runda review."];
    }

    if (msg) notify(msg[0], msg[1]).catch(() => {});
  }
}

// --- dopytywanie (clarify) -------------------------------------------------

/** Treść artefaktu bez nagłówka YAML. */
function artifactBody(path: string): string | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.split(/^---\s*$/m).slice(2).join("---").trim() || raw;
  } catch {
    return undefined;
  }
}

/**
 * Suspend w trybie pytań: komentuje pytania ABCD, czeka na odpowiedź autora
 * (dowolny komentarz bez markera fabryki) i wznawia doplanowanie. true = tryb
 * pytań obsłużony (pomiń przepływ aprobaty w tym ticku).
 */
async function handleClarifySuspend(
  project: string,
  src: LinearSource,
  id: string,
  runId: string,
  runDir: string,
  answered: Set<number>,
  answeredFallback: Set<number>,
  hintedRounds: Set<number>
): Promise<boolean> {
  const qFiles = safeReaddir(runDir).filter((f) => /^questions-round-\d+\.md$/.test(f));
  if (!qFiles.length) return false;
  const qMax = Math.max(...qFiles.map((f) => Number(f.match(/\d+/)![0])));
  // plan już OK → pytania rozstrzygnięte, ten suspend to bramka aprobaty
  const planBody = artifactBody(join(runDir, "plan.md")) ?? "";
  if (/^[`*\s]*PLAN:\s*OK\b/m.test(planBody)) return false;

  const comments = await src.listComments(id).catch(() => undefined);
  if (!comments) return true; // czkawka API — następny tick

  const qTag = `❓ Pytania do Ciebie (runda ${qMax})`;
  const qComment = comments.find((c) => c.body.includes(qTag));
  if (!qComment) {
    const qBody = artifactBody(join(runDir, `questions-round-${qMax}.md`)) ?? "(nie udało się odczytać pytań)";
    await src.comment(
      id,
      `${qTag} ${marker(id)} — ticket wymaga doprecyzowania przed planem.\n\n` +
        `Odpowiedz w komentarzu (np. \`1A, 2C\`), a potem **przeciągnij kartę na *${MAP.phases.planning}*** — doplanuję z Twoimi odpowiedziami.\n` +
          `Z telefonu: \`/answer 1A, 2C\`.\n\n---\n\n${qBody}`
    ).catch(() => {});
    registry.openGateRecord(id, { project, runId }, "clarify", qMax, "❓ Pytania do autora");
    await setPhase(project, src, id, "questions", runId);
    notify(`❓ ${id}: pytania do ticketu (runda ${qMax})`, "Odpowiedz w komentarzu — fabryka doplanuje.").catch(() => {});
    console.log(`[${id}] pytania rundy ${qMax} czekają na odpowiedź`);
    return true;
  }

  // idempotencja: znacznik z REJESTRU, nie fraza w komentarzu
  const gateRec = registry.readState(id)?.gates[registry.gateId("clarify", qMax)];
  if (gateRec?.decision?.resumeSentAt) {
    if (answered.has(qMax) && !answeredFallback.has(qMax)) {
      // wciąż suspended tick później — spróbuj pełnej ścieżki kroku w zagnieżdżonym workflow
      answeredFallback.add(qMax);
      fireResumeStep(runId, ["plan-clarify-cycle", "clarify-ticket"], { answers: gateRec.decision.payload ?? "" });
    }
    answered.add(qMax);
    return true;
  }

  // SYGNAŁ: przeciągnięcie karty ❓ Pytania → 🧠 Planowanie (kanonicznie) albo komenda /answer
  const state = await src.getStateName(id).catch(() => undefined);
  const byState = state ? decisionOfState(MAP, "clarify", state) === "answer" : false;
  const cmd = byState ? undefined : await readCommandDecision(src, id, qComment.createdAt);
  const byCommand = cmd?.decision?.kind === "answer";
  const answer = byState || byCommand
    ? (await collectPayload(src, id, qComment.createdAt)) ?? cmd?.decision?.payload
    : undefined;

  // komentarz z odpowiedziami bez sygnału → jednorazowa podpowiedź, jak je zatwierdzić
  if (!answer && cmd?.strayComment && !hintedRounds.has(qMax)) {
    hintedRounds.add(qMax);
    await src.comment(id, `${hintFor("clarify", { answer: MAP.phases.planning })} ${marker(id)}`).catch(() => {});
  }

  if (answer && !answered.has(qMax)) {
    answered.add(qMax);
    registry.recordDecision(id, { project, runId }, "clarify", qMax, {
      kind: "answer", payload: answer, via: byState ? "state" : "command", observedAt: new Date().toISOString(),
    });
    registry.markDecisionStep(id, { project, runId }, "clarify", qMax, "consumedAt");
    fireResumeStep(runId, "clarify-ticket", { answers: answer });
    registry.markDecisionStep(id, { project, runId }, "clarify", qMax, "resumeSentAt");
    await src.comment(id, `🧠 Odpowiedzi przyjęte ${marker(id)} — doplanowuję (runda ${qMax}).`).catch(() => {});
    await setPhase(project, src, id, "planning", runId);
    notify(`🧠 ${id}: odpowiedzi przyjęte`, `Doplanowanie (runda ${qMax}).`).catch(() => {});
    console.log(`[${id}] odpowiedzi rundy ${qMax} → resume clarify`);
  }
  return true;
}

// --- plan-reuse ------------------------------------------------------------

/**
 * REGUŁA (Bartosz 2026-07-22): istnieje zatwierdzony plan → reuse jest DOMYŚLNY.
 * Replan tylko z jawnego powodu: finał merytoryczny (verify FAIL po próbach /
 * bramka z pytaniami) albo odrzucenie planu przez człowieka. Zombie/budżet/
 * timeout/restart bez finału = reuse (nie generujemy planu bez powodu).
 */
async function findReusablePlan(src: LinearSource, id: string, description: string): Promise<string | undefined> {
  try {
    const comments = await src.listComments(id);
    const lastFinal = [...comments].reverse().find((c) =>
      c.body.includes(marker(id)) && (c.body.includes("🛑 BLOCKED") || c.body.includes("Run nieudany") || c.body.includes("Plan odrzucony")));
    const meritorious = lastFinal &&
      /BLOCKED po \d+\/\d+ próbach|plan bez PLAN: OK|niejasności blokujące|Pytania do autora|Plan odrzucony/.test(lastFinal.body);
    if (meritorious) return undefined; // plan się zdezaktualizował — świeże planowanie ma wartość

    const base = join(process.cwd(), "runs", id);
    const dirs = readdirSync(base)
      .map((d) => ({ d, m: statSync(join(base, d)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { d } of dirs) {
      try {
        const dir = join(base, d);
        // UWAGA: samo istnienie result.json (był PR) NIE blokuje reuse — PR mógł zostać
        // zamknięty bez merge (konflikt); ticket ze zmergowanym PR-em i tak jest Done i nie wraca do claimu
        const approval = JSON.parse(readFileSync(join(dir, "approval.json"), "utf8")) as { approved?: boolean; descriptionHash?: string };
        if (!approval.approved) continue;
        // ticket zmieniony po aprobacie → plan nieaktualny → replan
        if (approval.descriptionHash &&
            approval.descriptionHash !== createHash("sha256").update(description).digest("hex")) return undefined;
        const raw = readFileSync(join(dir, "plan.md"), "utf8");
        const body = raw.split(/^---\s*$/m).slice(2).join("---").trim() || raw;
        if (/^[`*\s]*PLAN:\s*OK\b/m.test(body)) return body;
      } catch { /* katalog bez kompletu artefaktów — próbujemy starszy */ }
    }
  } catch { /* brak katalogu runs — brak reuse */ }
  return undefined;
}

/** resume-async dowolnego kroku (clarify-ticket / approve-plan) — 504-odporny fire-and-forget. */
function fireResumeStep(runId: string, step: string | string[], resumeData: Record<string, unknown>) {
  fetch(`${FACTORY_API}/workflows/${WORKFLOW}/resume-async?runId=${runId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step, resumeData }),
  }).catch(() => {});
}

// --- prod smoke po merge (QA runda 2) -------------------------------------

const smokeDone = new Set<string>(); // jeden smoke per ticket per proces

/**
 * Po merge'u: poczekaj na deploy i sprawdź, czy zmiana ŻYJE na produkcji.
 * FAIL → ticket wraca do In Review + komentarz 🚨 + powiadomienie (koniec z cichym Done,
 * gdy funkcja jest martwa na prodzie — lekcja z BAR-101/102).
 */
async function prodSmokeGuard(projectKey: string, src: LinearSource, ticketId: string) {
  if (smokeDone.has(ticketId)) return;
  smokeDone.add(ticketId);

  const project = await getProject(projectKey).catch(() => undefined);
  const checks = project?.qa?.prodChecks;
  if (!checks?.length) return; // projekt bez configu QA — smoke nie dotyczy

  await sleep(90_000); // deploy potrzebuje chwili (Vercel po merge'u na main)

  let result = await runProdChecks(checks);
  for (let retry = 0; !result.ok && retry < 4; retry++) {
    await sleep(60_000); // może deploy jeszcze się propaguje
    result = await runProdChecks(checks);
  }

  if (result.ok) {
    await src.comment(ticketId, `🟢 Prod smoke OK ${marker(ticketId)} — zmiana żyje na produkcji:\n${result.report}`);
    console.log(`[${ticketId}] PROD SMOKE OK`);
  } else {
    await src.comment(
      ticketId,
      `🚨 Prod smoke FAILED ${marker(ticketId)} — merge jest, ale produkcja NIE serwuje zmiany:\n${result.report}\n\n` +
        `Ticket wraca do In Review — zweryfikuj deploy/hosting (por. BAR-77/102).`
    );
    await src.setStatus(ticketId, "human_review");
    notify(`🚨 ${ticketId}: prod smoke FAILED`, "Merge jest, ale produkcja nie serwuje zmiany — szczegóły w tickecie.").catch(() => {});
    console.log(`[${ticketId}] PROD SMOKE FAILED`);
  }
}

// --- decyzja człowieka w Linear -------------------------------------------

/**
 */
/**
 * Decyzja z komentarza — WYŁĄCZNIE ścisła komenda (`/approve`, `/reject`, `/answer`).
 * Rozpoznawanie fraz („zatwierdzam", „odrzuć") zostało usunięte: sterowanie
 * przepływem idzie przez przejścia stanów, a komenda jest jedyną furtką tekstową.
 * Zwraca też komentarze, które NIE były komendą — do wysłania podpowiedzi.
 */
async function readCommandDecision(
  src: LinearSource,
  id: string,
  sinceIso: string
): Promise<{ decision?: { kind: registry.DecisionKind; payload?: string }; strayComment: boolean }> {
  const comments = await src.listComments(id).catch(() => []);
  let stray = false;
  for (const c of comments) {
    if (c.createdAt <= sinceIso || c.body.includes(marker(id))) continue;
    const cmd = parseCommand(c.body);
    if (cmd) return { decision: { kind: cmd.kind, payload: cmd.payload }, strayComment: false };
    stray = true; // komentarz człowieka bez sygnału — payload dla decyzji ze stanu albo powód podpowiedzi
  }
  return { strayComment: stray };
}

/** Komentarze człowieka od otwarcia bramki — payload decyzji (dane, nie sterowanie). */
async function collectPayload(src: LinearSource, id: string, sinceIso: string): Promise<string | undefined> {
  const comments = await src.listComments(id).catch(() => []);
  const human = comments
    .filter((c) => c.createdAt > sinceIso && !c.body.includes(marker(id)))
    .map((c) => c.body.trim())
    .filter(Boolean);
  return human.length ? human.join("\n\n") : undefined;
}

// --- Mastra HTTP API ------------------------------------------------------

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${FACTORY_API}/workflows`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function createRun(): Promise<string> {
  const res = await fetch(`${FACTORY_API}/workflows/${WORKFLOW}/create-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`create-run: HTTP ${res.status}`);
  const { runId } = (await res.json()) as { runId: string };
  return runId;
}

/** start-async trzyma połączenie i po 180 s dostaje 504 — run i tak leci; stan śledzimy pollingiem. */
function fireStart(runId: string, inputData: Record<string, unknown>) {
  fetch(`${FACTORY_API}/workflows/${WORKFLOW}/start-async?runId=${runId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputData }),
  }).catch(() => {});
}

/** resume-async jak start-async: 504-odporny fire-and-forget. */
function fireResume(runId: string, resumeData: { approved: boolean; feedback?: string }) {
  fetch(`${FACTORY_API}/workflows/${WORKFLOW}/resume-async?runId=${runId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "approve-plan", resumeData }),
  }).catch(() => {});
}

async function getRun(runId: string): Promise<unknown> {
  const res = await fetch(`${FACTORY_API}/workflows/${WORKFLOW}/runs/${runId}`);
  if (!res.ok) throw new Error(`get run: HTTP ${res.status}`);
  return res.json();
}

// --- odczyt stanu runa (kształt snapshotu bywa niestabilny — czytamy defensywnie) ---

function runStatus(run: unknown): string {
  const r = run as { status?: string; snapshot?: { status?: string } };
  return r.status ?? r.snapshot?.status ?? "unknown";
}

function errorMessage(run: unknown): string {
  const found = findString(run, "message", (path) => path.includes("error"));
  return found ?? "(brak komunikatu błędu)";
}

/** Rekurencyjnie szuka najdłuższego stringa pod danym kluczem. */
function findString(
  obj: unknown,
  key: string,
  pathFilter: (path: string[]) => boolean = () => true,
  path: string[] = []
): string | undefined {
  if (obj === null || typeof obj !== "object") return undefined;
  let best: string | undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key && typeof v === "string" && v.length > 0 && pathFilter(path)) {
      if (!best || v.length > best.length) best = v;
    }
    const nested = findString(v, key, pathFilter, [...path, k]);
    if (nested && (!best || nested.length > best.length)) best = nested;
  }
  return best;
}

// --- media / drobnica -----------------------------------------------------

/** Wszystkie screenshoty runu (screenshot.png + screenshot-N.png widoków z planu) → CDN Lineara → markdown. */
async function uploadScreenshot(src: LinearSource, ticketId: string, runId: string): Promise<string> {
  try {
    const dir = join(process.cwd(), "runs", ticketId, runId);
    const files = readdirSync(dir).filter((f) => /^screenshot(-\d+)?\.png$/.test(f)).sort();
    const parts: string[] = [];
    for (const f of files) {
      const png = readFileSync(join(dir, f));
      const assetUrl = await src.uploadFile(`${ticketId}-${f}`, "image/png", png);
      parts.push(`![${f} ${ticketId}](${assetUrl})`);
    }
    return parts.length ? `\n\n**Podgląd (oceń UI przed merge):**\n${parts.join("\n")}` : "";
  } catch {
    return ""; // brak screenshotów (projekt bez configu / zrzuty się nie udały) — komentarz bez podglądu
  }
}

/**
 * Cięcie OD ŚRODKA: początek (diagnoza/zakres) i koniec (ryzyka/niejasności —
 * najważniejsze dla ludzkiej decyzji) zawsze widoczne; wycinka w detalach.
 */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n… ✂️ (wycięto ${s.length - max} znaków ze środka — pełny plan w runs/) …\n\n${s.slice(-tail)}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimalny loader .env — bez nowej zależności. Szuka obok src/sources/ → ai-factory/.env. */
function loadDotEnv() {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* brak .env — polegamy na env procesu */
  }
}

main().catch((err) => {
  console.error("Poller padł:", err);
  process.exit(1);
});
