import { MastraHttpError } from "../sources/mastra-client";

/**
 * Czysta polityka ponowień outboxu: klasyfikacja błędu dispatchu oraz
 * wykładniczy backoff z jitterem. Zero I/O — decyzje wykonuje poller.
 */
export type DispatchErrorClass = "transient" | "permanent" | "terminal";

/** Błąd, którego ponowienie bez interwencji nie może zmienić wyniku. */
export class FatalDispatchError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "FatalDispatchError";
  }
}

const TRANSIENT_PATTERN =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network|timed?\s?out|could not resolve|rate limit|temporar/i;

export function classifyDispatchError(error: unknown): DispatchErrorClass {
  if (error instanceof FatalDispatchError) return "terminal";
  if (error instanceof MastraHttpError) {
    return error.status >= 500 || error.status === 429 ? "transient" : "permanent";
  }
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "transient";
    if (TRANSIENT_PATTERN.test(`${error.name} ${error.message}`)) return "transient";
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && TRANSIENT_PATTERN.test(`${cause.name} ${cause.message}`)) {
      return "transient";
    }
  }
  return "permanent";
}

/** Maksymalna liczba prób outboxu zanim komenda trafi do dead-letter. */
export function maxDispatchAttempts(errorClass: DispatchErrorClass): number {
  if (errorClass === "terminal") return 0;
  // attempts w lifecycle_commands rośnie także przy markach dispatched/done,
  // więc limit transient jest wyższy niż liczba realnych ponowień.
  return errorClass === "transient"
    ? Number(process.env.FACTORY_OUTBOX_MAX_TRANSIENT ?? 8)
    : 2;
}

/** ISO timestamp kolejnej próby: min(30 min, 30 s · 2^(attempts−1)) + jitter 0–30%. */
export function backoffAt(attempts: number, from = new Date()): string {
  const base = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  const jitter = base * 0.3 * Math.random();
  return new Date(from.getTime() + base + jitter).toISOString();
}
