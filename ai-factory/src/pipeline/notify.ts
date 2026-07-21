import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Powiadomienia dla człowieka: „agent czegoś potrzebuje" + finały.
 * Kanały włączane obecnością configu, wołane fire-and-forget — NIGDY nie wywalają pollera.
 *  - macOS notification center: zawsze (osascript, zero zależności),
 *  - Telegram: gdy TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID w env/.env.
 */
export async function notify(title: string, message: string): Promise<void> {
  await Promise.allSettled([notifyMacos(title, message), notifyTelegram(title, message)]);
}

async function notifyMacos(title: string, message: string): Promise<void> {
  try {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 240);
    await exec("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`]);
  } catch (err) {
    console.error("notify macos nieudane:", err instanceof Error ? err.message : err);
  }
}

async function notifyTelegram(title: string, message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // kanał nieskonfigurowany — cicho pomijamy
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `${title}\n${message}`.slice(0, 4000) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("notify telegram nieudane:", err instanceof Error ? err.message : err);
  }
}
