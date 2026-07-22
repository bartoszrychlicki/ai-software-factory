import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
type CommandRunner = (file: string, args: readonly string[]) => Promise<unknown>;
type MacosNotificationOptions = { cache?: boolean };

/**
 * Powiadomienia dla człowieka: „agent czegoś potrzebuje" + finały.
 * Kanały włączane obecnością configu, wołane fire-and-forget — NIGDY nie wywalają pollera.
 *  - macOS notification center: terminal-notifier; ticket otwiera Linear app lub WWW,
 *    osascript jest wyłącznie awaryjnym fallbackiem,
 *  - Telegram: gdy TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID w env/.env; ticket ma przycisk WWW.
 */
export async function notify(title: string, message: string, url?: string): Promise<void> {
  await Promise.allSettled([notifyMacos(title, message, url), notifyTelegram(title, message, url)]);
}

const LINEAR_APP_CACHE_TTL_MS = 5 * 60_000;
let linearAppCache: { expiresAt: number; present: Promise<boolean> } | undefined;

function detectLinearApp(run: CommandRunner): Promise<boolean> {
  return run("open", ["-Ra", "Linear"]).then(
    () => true,
    () => false,
  );
}

async function hasLinearApp(run: CommandRunner, cache: boolean): Promise<boolean> {
  if (!cache) return detectLinearApp(run);
  const now = Date.now();
  if (!linearAppCache || linearAppCache.expiresAt <= now) {
    linearAppCache = {
      expiresAt: now + LINEAR_APP_CACHE_TTL_MS,
      present: detectLinearApp(run),
    };
  }
  return linearAppCache.present;
}

export function resolveClickTarget(url: string, appPresent: boolean): string {
  return appPresent ? url.replace(/^https:\/\//, "linear://") : url;
}

export async function notifyMacos(
  title: string,
  message: string,
  url?: string,
  run: CommandRunner = exec,
  { cache = true }: MacosNotificationOptions = {},
): Promise<void> {
  const args = ["-title", title, "-message", message];
  if (url) {
    args.push("-open", resolveClickTarget(url, await hasLinearApp(run, cache)));
  }

  try {
    await run("terminal-notifier", args);
  } catch {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 240);
    try {
      await run("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`]);
    } catch (err) {
      console.error("notify macos nieudane:", err instanceof Error ? err.message : err);
    }
  }
}

export async function notifyTelegram(title: string, message: string, url?: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // kanał nieskonfigurowany — cicho pomijamy
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: `${title}\n${message}`.slice(0, 4000),
    };
    if (url) {
      body.reply_markup = { inline_keyboard: [[{ text: "Otwórz w Linear", url }]] };
    }
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("notify telegram nieudane:", err instanceof Error ? err.message : err);
  }
}
