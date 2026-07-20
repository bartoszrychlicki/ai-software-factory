/**
 * Poller Linear → ticket-pipeline.
 *
 * Co INTERVAL sprawdza projekt w Linear (label `agent:ready`, stan backlog/todo),
 * claimuje ticket (zdejmuje label, przestawia na In Progress) i startuje run
 * pipeline'u przez HTTP API Mastry. Raportuje komentarzami do issue:
 * przyjęcie → plan (czeka na aprobatę w Studio) → wynik (PR albo BLOCKED).
 *
 * Uruchomienie:  npx tsx src/sources/poll-linear.ts [--once]
 * Wymaga: LINEAR_API_KEY (env lub .env), działającego `mastra dev`.
 * Idempotencja: marker `[linear:<ISSUE>:v1]` w komentarzach + zdjęcie labela
 * przy claim — ticket nie zostanie podjęty drugi raz.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LinearSource } from "./linear";

// --- konfiguracja ---------------------------------------------------------

loadDotEnv();
const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) {
  console.error("Brak LINEAR_API_KEY (env lub ai-factory/.env)");
  process.exit(1);
}
const PROJECT = process.env.LINEAR_PROJECT ?? "pilot-app";
const FACTORY_API = process.env.FACTORY_API ?? "http://localhost:4111/api";
const WORKFLOW = "ticketPipeline";
const POLL_INTERVAL_MS = 60_000;
const RUN_WATCH_INTERVAL_MS = 20_000;
const RUN_WATCH_MAX_MS = 24 * 60 * 60_000; // human gate może czekać długo

const source = new LinearSource(API_KEY, PROJECT);
const active = new Set<string>(); // tickety obsługiwane w tym procesie

// --- główna pętla ---------------------------------------------------------

const once = process.argv.includes("--once");

async function main() {
  do {
    try {
      const tickets = await source.listReady();
      for (const t of tickets) {
        if (active.has(t.id)) continue;
        active.add(t.id);
        // fire-and-forget: każdy ticket żyje własnym cyklem, pętla polluje dalej
        handleTicket(t.id, t.title, t.description, t.labels).catch((err) => {
          console.error(`[${t.id}] nieobsłużony błąd:`, err);
          active.delete(t.id);
        });
      }
    } catch (err) {
      console.error("Poll nieudany:", err instanceof Error ? err.message : err);
    }
    if (!once) await sleep(POLL_INTERVAL_MS);
  } while (!once);

  // --once: daj dokończyć wystartowanym ticketom zanim proces umrze
  while (active.size > 0) await sleep(5_000);
}

async function handleTicket(id: string, title: string, description: string, labels: string[]) {
  const marker = `[linear:${id}:v1]`;
  console.log(`[${id}] claim: ${title}`);
  await source.claim(id);
  await source.comment(id, `🤖 ai-factory przyjęła ticket ${marker}. Planner startuje.`);

  const runId = await createRun();
  fireStart(runId, { id, title, description, project: PROJECT, labels });
  console.log(`[${id}] run ${runId} wystartowany`);

  let planCommentedAt: string | undefined;
  let decisionSent = false;
  const deadline = Date.now() + RUN_WATCH_MAX_MS;
  while (Date.now() < deadline) {
    await sleep(RUN_WATCH_INTERVAL_MS);
    const run = await getRun(runId);
    const status = runStatus(run);

    if (status === "suspended" && !planCommentedAt) {
      planCommentedAt = new Date().toISOString();
      const plan = findString(run, "plan") ?? "(nie udało się odczytać planu z runa)";
      await source.comment(
        id,
        `📋 Plan gotowy ${marker} — czeka na Twoją decyzję.\n\n` +
          `**Odpowiedz komentarzem:** \`zatwierdzam\` — buduję, albo \`odrzuć: <powód>\` — przerywam.\n` +
          `(Aprobata w Studio też nadal działa: run \`${runId}\`.)\n\n---\n\n${clip(plan, 8000)}`
      );
      console.log(`[${id}] plan czeka na decyzję w Linear`);
    } else if (status === "suspended" && planCommentedAt && !decisionSent) {
      const decision = await readDecision(id, planCommentedAt, marker);
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
      const screenshotMd = await uploadScreenshot(id, runId);
      await source.comment(
        id,
        `✅ Zbudowane i zweryfikowane ${marker}. PR: ${prUrl}\n\n` +
          `${reviewLine}\n\n${clip(review, 4000)}${screenshotMd}\n\nMerge = decyzja człowieka.`
      );
      await source.setStatus(id, "human_review");
      console.log(`[${id}] SUKCES → ${prUrl}`);
      break;
    }

    if (status === "failed") {
      const msg = errorMessage(run);
      const blocked = /BLOCKED|odrzucony/i.test(msg);
      await source.comment(
        id,
        `${blocked ? "🛑 BLOCKED" : "❌ Run nieudany"} ${marker}\n\n${clip(msg, 6000)}\n\n` +
          `Uzupełnij ticket i nadaj ponownie label \`agent:ready\`, żeby fabryka spróbowała jeszcze raz.`
      );
      await source.setStatus(id, blocked ? "needs_clarification" : "blocked");
      console.log(`[${id}] FAILED${blocked ? " (BLOCKED)" : ""}`);
      break;
    }
  }
  active.delete(id);
}

// --- Mastra HTTP API ------------------------------------------------------

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

/** start-async trzyma połączenie do suspend/końca i potrafi paść na gateway timeout — run i tak leci; stan śledzimy pollingiem. */
function fireStart(runId: string, inputData: Record<string, unknown>) {
  fetch(`${FACTORY_API}/workflows/${WORKFLOW}/start-async?runId=${runId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputData }),
  }).catch(() => {});
}

/**
 * Decyzja człowieka w komentarzach Lineara: `zatwierdzam` / `odrzuć: powód`.
 * Bramka pozostaje LUDZKA — fabryka tylko czyta komentarz napisany ręcznie w Linear.
 * Komentarze fabryki niosą marker i są pomijane; liczą się tylko nowsze niż komentarz z planem.
 */
async function readDecision(
  id: string,
  sinceIso: string,
  marker: string
): Promise<{ approved: boolean; feedback?: string } | undefined> {
  const comments = await source.listComments(id).catch(() => []);
  for (const c of comments) {
    if (c.createdAt <= sinceIso || c.body.includes(marker)) continue;
    const body = c.body.trim();
    if (/^(zatwierdzam|approve|ok)\b/i.test(body)) return { approved: true };
    const reject = body.match(/^(odrzuć|odrzucam|reject)\b[:\s]*([\s\S]*)/i);
    if (reject) return { approved: false, feedback: reject[2].trim() || "odrzucone w Linear bez powodu" };
  }
  return undefined;
}

/** Screenshot z verify (runs/<ticket>/<runId>/screenshot.png) → CDN Lineara → markdown do komentarza. */
async function uploadScreenshot(ticketId: string, runId: string): Promise<string> {
  try {
    const png = readFileSync(join(process.cwd(), "runs", ticketId, runId, "screenshot.png"));
    const assetUrl = await source.uploadFile(`${ticketId}-screenshot.png`, "image/png", png);
    return `\n\n**Podgląd:**\n![screenshot ${ticketId}](${assetUrl})`;
  } catch {
    return ""; // brak screenshota (projekt bez configu / screenshot się nie udał) — komentarz bez podglądu
  }
}

/** resume-async jak start-async: 504-odporny fire-and-forget, stan śledzimy pollingiem. */
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

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n\n… (ucięte)" : s;
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
