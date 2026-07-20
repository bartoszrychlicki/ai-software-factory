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

function statePath(): string {
  return join(dirname(findUpFile("package.json")), "runs", "circuit-breaker.json");
}

async function read(): Promise<BreakerState> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as BreakerState;
  } catch {
    return { failStreak: 0 };
  }
}

async function write(state: BreakerState): Promise<void> {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify(state, null, 2));
}

/** Otwarty? Zwraca powód albo null. Po cooldownie sam się domyka (half-open: jedna szansa). */
export async function breakerOpen(): Promise<string | null> {
  const s = await read();
  if (!s.openedAt) return null;
  const ageMin = (Date.now() - Date.parse(s.openedAt)) / 60_000;
  if (ageMin >= COOLDOWN_MIN) {
    await write({ failStreak: BLOCKED_STREAK_LIMIT - 1 }); // half-open: kolejna porażka otwiera od razu
    return null;
  }
  return `${s.reason} (otwarty ${Math.round(ageMin)} min temu, cooldown ${COOLDOWN_MIN} min; reset: usuń runs/circuit-breaker.json)`;
}

export async function recordRunOutcome(success: boolean): Promise<void> {
  const s = await read();
  if (success) {
    await write({ failStreak: 0 });
    return;
  }
  const failStreak = s.failStreak + 1;
  if (failStreak >= BLOCKED_STREAK_LIMIT && !s.openedAt) {
    await write({
      openedAt: new Date().toISOString(),
      reason: `${failStreak} nieudane runy z rzędu`,
      failStreak,
    });
  } else {
    await write({ ...s, failStreak });
  }
}

/** Koszt (ekwiwalent API) z ostatniej godziny — druga przesłanka otwarcia. */
export async function checkHourlySpend(): Promise<void> {
  let usd = 0;
  try {
    const path = join(dirname(findUpFile("package.json")), "runs", "metrics.jsonl");
    const cutoff = Date.now() - 60 * 60_000;
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line) as MetricRow;
      if (Date.parse(r.ts) >= cutoff) usd += r.costUsd ?? 0;
    }
  } catch {
    return;
  }
  if (usd > USD_PER_HOUR_LIMIT) {
    const s = await read();
    if (!s.openedAt) {
      await write({
        openedAt: new Date().toISOString(),
        reason: `koszt $${usd.toFixed(2)}/h > limit $${USD_PER_HOUR_LIMIT}/h`,
        failStreak: s.failStreak,
      });
    }
  }
}
