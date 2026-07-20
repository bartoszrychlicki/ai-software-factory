import { spawn } from "node:child_process";

/**
 * Podgląd wyniku: stawia serwer projektu (np. vite preview) w katalogu checkoutu,
 * czeka aż URL odpowie, robi pełnostronicowy screenshot i ubija serwer.
 * Zwraca PNG albo undefined — screenshot jest doradczy i NIGDY nie wywala pipeline'u.
 */
export async function takeScreenshot(
  cwd: string,
  config: { start: string; url: string },
  cleanEnv: NodeJS.ProcessEnv
): Promise<Buffer | undefined> {
  const server = spawn("bash", ["-c", config.start], { cwd, env: cleanEnv, stdio: "ignore", detached: true });
  try {
    const up = await waitForUrl(config.url, 30_000);
    if (!up) return undefined;

    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(config.url, { waitUntil: "networkidle", timeout: 15_000 });
      return await page.screenshot({ fullPage: true, type: "png" });
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error("Screenshot nieudany:", err instanceof Error ? err.message : err);
    return undefined;
  } finally {
    // detached + ujemny PID = ubijamy całą grupę procesów (bash + serwer-dziecko)
    try {
      if (server.pid) process.kill(-server.pid, "SIGTERM");
    } catch {
      /* serwer już nie żyje */
    }
  }
}

async function waitForUrl(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch {
      /* jeszcze nie wstał */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
