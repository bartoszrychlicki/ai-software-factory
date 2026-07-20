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
 * Aprobata planu: komentarz `zatwierdzam` / `odrzuć: powód` w Linear
 * (polling co RUN_WATCH_INTERVAL; Studio działa równolegle jako fallback).
 *
 * Uruchomienie:  npx tsx src/sources/poll-linear.ts [--once]
 * Produkcyjnie: usługa launchd (ops/install-launchd.sh).
 * Wymaga: LINEAR_API_KEY (env lub .env), działającego `mastra dev`.
 * Idempotencja: marker `[linear:<ISSUE>:v1]` w komentarzach + zdjęcie labela.
 */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LinearSource } from "./linear";
import { getProject } from "../pipeline/projects";
import { breakerOpen, recordRunOutcome, checkHourlySpend } from "../pipeline/breaker";

const exec = promisify(execFile);

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

const marker = (id: string) => `[linear:${id}:v1]`;

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
            breakerLogged = true;
          }
        } else {
          breakerLogged = false;
          for (const { project, src } of sources) {
            const tickets = await src.listReady().catch((err) => {
              console.error(`[${project}] listReady nieudane:`, err instanceof Error ? err.message : err);
              return [];
            });
            for (const t of tickets) {
              if (active.has(t.id)) continue;
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
  await src.claim(id);
  await src.comment(id, `🤖 ai-factory przyjęła ticket ${marker(id)}. Planner startuje.`);

  const runId = await createRun();
  fireStart(runId, { id, title, description, project, labels });
  console.log(`[${id}] run ${runId} wystartowany`);
  await watchRun(src, id, runId);
}

/**
 * Opiekun runa: komentuje plan, nasłuchuje ludzkiej decyzji w Linear,
 * raportuje finał. planCommentedAtInit ≠ undefined = adopcja (plan już
 * skomentowany przed restartem pollera).
 */
async function watchRun(src: LinearSource, id: string, runId: string, planCommentedAtInit?: string) {
  let planCommentedAt = planCommentedAtInit;
  let decisionSent = false;
  const deadline = Date.now() + RUN_WATCH_MAX_MS;

  try {
    while (Date.now() < deadline) {
      await sleep(RUN_WATCH_INTERVAL_MS);
      const run = await getRun(runId).catch(() => undefined);
      if (!run) continue; // serwer chwilowo w dole — czekamy, run w Mastrze nie znika
      const status = runStatus(run);

      if (status === "suspended" && !planCommentedAt) {
        planCommentedAt = new Date().toISOString();
        const plan = findString(run, "plan") ?? "(nie udało się odczytać planu z runa)";
        await src.comment(
          id,
          `📋 Plan gotowy ${marker(id)} — czeka na Twoją decyzję.\n\n` +
            `**Odpowiedz komentarzem:** \`zatwierdzam\` — buduję, albo \`odrzuć: <powód>\` — przerywam.\n` +
            `(Aprobata w Studio też nadal działa: run \`${runId}\`.)\n\n---\n\n${clip(plan, 16000)}`
        );
        console.log(`[${id}] plan czeka na decyzję w Linear`);
      } else if (status === "suspended" && planCommentedAt && !decisionSent) {
        const decision = await readDecision(src, id, planCommentedAt);
        if (decision) {
          decisionSent = true;
          fireResume(runId, decision);
          console.log(`[${id}] decyzja z Linear: ${decision.approved ? "ZATWIERDZONO" : "ODRZUCONO"}`);
        }
      }

      if (status === "success") {
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
        await recordRunOutcome(true).catch(() => {});
        console.log(`[${id}] SUKCES → ${prUrl}`);
        break;
      }

      if (status === "failed") {
        const msg = errorMessage(run);
        const blocked = /BLOCKED|odrzucony/i.test(msg);
        await src.comment(
          id,
          `${blocked ? "🛑 BLOCKED" : "❌ Run nieudany"} ${marker(id)}\n\n${clip(msg, 6000)}\n\n` +
            `Uzupełnij ticket i nadaj ponownie label \`agent:ready\`, żeby fabryka spróbowała jeszcze raz.`
        );
        await src.setStatus(id, blocked ? "needs_clarification" : "blocked");
        // odrzucenie planu przez człowieka to nie porażka fabryki — nie nabija serii bezpiecznika
        if (!/odrzucony przez człowieka/i.test(msg)) await recordRunOutcome(false).catch(() => {});
        console.log(`[${id}] FAILED${blocked ? " (BLOCKED)" : ""}`);
        break;
      }
    }
  } finally {
    active.delete(id);
  }
}

// --- adopcja sierot po restarcie pollera ----------------------------------

async function adoptOrphans() {
  for (const { src } of sources) {
  const issues = await src.listWithComments("In Progress");
  for (const issue of issues) {
    if (active.has(issue.id)) continue;
    const mine = issue.comments.filter((c) => c.body.includes(marker(issue.id)));
    if (mine.length === 0) continue; // nie nasz ticket
    // runId z najnowszego komentarza z planem (zawiera "run `<uuid>`")
    const runId = mine
      .map((c) => c.body.match(/run `([0-9a-f-]{36})`/)?.[1])
      .filter(Boolean)
      .pop();
    if (!runId) continue;
    const planComment = mine.filter((c) => c.body.includes("Plan gotowy")).pop();
    active.add(issue.id);
    console.log(`[${issue.id}] ADOPCJA sieroconego runa ${runId}`);
    watchRun(src, issue.id, runId, planComment?.createdAt).catch((err) => {
      console.error(`[${issue.id}] adopcja padła:`, err);
      active.delete(issue.id);
    });
  }
  }
}

// --- merge-watcher: domknięcie cyklu ticketu ------------------------------

async function watchMerges() {
  for (const { project, src } of sources) {
  const issues = await src.listWithComments("In Review");
  for (const issue of issues) {
    if (mergeHandled.has(issue.id)) continue;
    const mine = issue.comments.filter((c) => c.body.includes(marker(issue.id)));
    const prUrl = mine
      .map((c) => c.body.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0])
      .filter(Boolean)
      .pop();
    if (!prUrl) continue;

    let pr: { state: string; headRefName: string };
    try {
      const { stdout } = await exec("gh", ["pr", "view", prUrl, "--json", "state,headRefName"]);
      pr = JSON.parse(stdout);
    } catch {
      continue; // gh chwilowo nie działa — spróbujemy w kolejnym cyklu
    }

    if (pr.state === "MERGED") {
      mergeHandled.add(issue.id);
      await cleanupAfterMerge(project, issue.id, pr.headRefName);
      await src.comment(issue.id, `🎉 PR zmergowany ${marker(issue.id)} — ticket zamknięty, workspace posprzątany.`);
      await src.setStatus(issue.id, "done");
      console.log(`[${issue.id}] MERGED → Done`);
    } else if (pr.state === "CLOSED") {
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

// --- decyzja człowieka w Linear -------------------------------------------

/**
 * `zatwierdzam` / `odrzuć: powód` w komentarzach. Bramka pozostaje LUDZKA —
 * fabryka tylko czyta komentarz napisany ręcznie w Linear. Komentarze fabryki
 * niosą marker i są pomijane; liczą się tylko nowsze niż komentarz z planem.
 */
async function readDecision(
  src: LinearSource,
  id: string,
  sinceIso: string
): Promise<{ approved: boolean; feedback?: string } | undefined> {
  const comments = await src.listComments(id).catch(() => []);
  for (const c of comments) {
    if (c.createdAt <= sinceIso || c.body.includes(marker(id))) continue;
    const body = c.body.trim();
    if (/^(zatwierdzam|akceptuję|akceptuje|zgoda|approve|approved|ok|lgtm)\b/i.test(body)) return { approved: true };
    const reject = body.match(/^(odrzuć|odrzucam|reject)\b[:\s]*([\s\S]*)/i);
    if (reject) return { approved: false, feedback: reject[2].trim() || "odrzucone w Linear bez powodu" };
  }
  return undefined;
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

/** Screenshot z verify (runs/<ticket>/<runId>/screenshot.png) → CDN Lineara → markdown do komentarza. */
async function uploadScreenshot(src: LinearSource, ticketId: string, runId: string): Promise<string> {
  try {
    const png = readFileSync(join(process.cwd(), "runs", ticketId, runId, "screenshot.png"));
    const assetUrl = await src.uploadFile(`${ticketId}-screenshot.png`, "image/png", png);
    return `\n\n**Podgląd:**\n![screenshot ${ticketId}](${assetUrl})`;
  } catch {
    return ""; // brak screenshota (projekt bez configu / screenshot się nie udał) — komentarz bez podglądu
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
