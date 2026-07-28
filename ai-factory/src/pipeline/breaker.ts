import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findUpFile } from "./projects";
import type { MetricRow } from "./metrics";

/**
 * Circuit breaker fabryki: po serii BLOCKED/FAILED albo przekroczeniu kosztu
 * godzinowego poller przestaje podejmować NOWE tickety (labele zostają, nic
 * nie przepada). Stan w runs/circuit-breaker.json — reset: skasuj plik albo
 * poczekaj na cooldown. Chroni okna limitów subskrypcji, nie fakturę.
 */
const BLOCKED_STREAK_LIMIT = Number(process.env.FACTORY_CB_BLOCKED_STREAK ?? 3);
const USD_PER_HOUR_LIMIT = Number(process.env.FACTORY_CB_USD_PER_H ?? 10);
const COOLDOWN_MIN = Number(process.env.FACTORY_CB_COOLDOWN_MIN ?? 360);

interface BreakerState {
  openedAt?: string; // ISO — obecny = bezpiecznik otwarty
  reason?: string;
  failStreak: number;
}

/**
 * Ścieżka stanu jest wiązana raz, na wejściu funkcji publicznej — wywołania
 * fire-and-forget nie mogą po awaitach trafić w inny FACTORY_ROOT.
 */
function statePath(): string {
  return join(dirname(findUpFile("package.json")), "runs", "circuit-breaker.json");
}

async function read(path: string): Promise<BreakerState> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as BreakerState;
  } catch {
    return { failStreak: 0 };
  }
}

async function write(path: string, state: BreakerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2));
}

/** Otwarty? Zwraca powód albo null. Po cooldownie sam się domyka (half-open: jedna szansa). */
export async function breakerOpen(): Promise<string | null> {
  const path = statePath();
  const s = await read(path);
  if (!s.openedAt) return null;
  const ageMin = (Date.now() - Date.parse(s.openedAt)) / 60_000;
  if (ageMin >= COOLDOWN_MIN) {
    await write(path, { failStreak: BLOCKED_STREAK_LIMIT - 1 }); // half-open: kolejna porażka otwiera od razu
    return null;
  }
  return `${s.reason} (otwarty ${Math.round(ageMin)} min temu, cooldown ${COOLDOWN_MIN} min; reset: usuń runs/circuit-breaker.json)`;
}

export async function recordRunOutcome(success: boolean): Promise<void> {
  const path = statePath();
  const s = await read(path);
  if (success) {
    await write(path, { failStreak: 0 });
    return;
  }
  const failStreak = s.failStreak + 1;
  if (failStreak >= BLOCKED_STREAK_LIMIT && !s.openedAt) {
    await write(path, {
      openedAt: new Date().toISOString(),
      reason: `${failStreak} nieudane runy z rzędu`,
      failStreak,
    });
  } else {
    await write(path, { ...s, failStreak });
  }
}

/**
 * Koszt (ekwiwalent API) z ostatniej godziny — druga przesłanka otwarcia.
 * `extraUsd` pozwala pollerowi v2 dołożyć sumę z lifecycle_stage_attempts;
 * oba ledgery liczą to samo z różnych stron, więc bierzemy max, nie sumę.
 */
export async function checkHourlySpend(extraUsd = 0): Promise<void> {
  const breakerPath = statePath();
  const metricsPath = join(dirname(findUpFile("package.json")), "runs", "metrics.jsonl");
  let usd = 0;
  try {
    const cutoff = Date.now() - 60 * 60_000;
    for (const line of (await readFile(metricsPath, "utf8")).split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line) as MetricRow;
      if (Date.parse(r.ts) >= cutoff) usd += r.costUsd ?? 0;
    }
  } catch {
    // brak metrics.jsonl nie wyłącza drugiego źródła
  }
  usd = Math.max(usd, extraUsd);
  if (usd > USD_PER_HOUR_LIMIT) {
    const s = await read(breakerPath);
    if (!s.openedAt) {
      await write(breakerPath, {
        openedAt: new Date().toISOString(),
        reason: `koszt $${usd.toFixed(2)}/h > limit $${USD_PER_HOUR_LIMIT}/h`,
        failStreak: s.failStreak,
      });
    }
  }
}
