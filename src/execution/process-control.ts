import { spawn, type ChildProcess } from "node:child_process";

export interface ControlledProcess {
  reason(): "abort" | "timeout" | undefined;
  dispose(): void;
}

/**
 * Steruje całą grupą procesu, nie tylko bezpośrednim CLI.
 *
 * Agentowe CLI potrafią uruchamiać własne dzieci. Sam `workflow.cancel()` zmienia
 * status Mastry, ale bez jawnego sygnału proces potomny może dalej zużywać budżet.
 */
export function controlProcess(
  child: ChildProcess,
  options: { signal?: AbortSignal; timeoutMs?: number; killGraceMs?: number } = {}
): ControlledProcess {
  let stopped = false;
  let stopReason: "abort" | "timeout" | undefined;
  let hardKill: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;

  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Proces zdążył się zakończyć.
      }
    }
  };

  const terminate = (reason: "abort" | "timeout") => {
    if (stopped || stopReason) return;
    stopReason = reason;
    signalGroup("SIGTERM");
    hardKill = setTimeout(() => signalGroup("SIGKILL"), options.killGraceMs ?? 5_000);
    hardKill.unref();
  };

  const onAbort = () => terminate("abort");
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  if (options.timeoutMs && options.timeoutMs > 0) {
    timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    timeout.unref();
  }

  const dispose = () => {
    if (stopped) return;
    stopped = true;
    if (timeout) clearTimeout(timeout);
    if (hardKill) clearTimeout(hardKill);
    options.signal?.removeEventListener("abort", onAbort);
  };
  child.once("exit", dispose);
  child.once("error", dispose);

  return {
    reason: () => stopReason,
    dispose,
  };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Promise-owa wersja execFile z kontrolą grupy procesów i zachowanym stdout/stderr. */
export function execFileControlled(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBuffer?: number;
    input?: string | Buffer;
  } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const control = controlProcess(child, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let bufferError: Error | undefined;
    const limit = options.maxBuffer ?? 50 * 1024 * 1024;
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > limit && !bufferError) {
        bufferError = new Error(`Przekroczono maxBuffer ${limit} B.`);
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      control.dispose();
      reject(error);
    });
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      settled = true;
      control.dispose();
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code === 0 && !bufferError && !control.reason()) {
        resolve({ stdout: stdoutText, stderr: stderrText });
        return;
      }
      const error = bufferError ?? new Error(
        `Proces ${file} zakończył się kodem ${code ?? "null"}${exitSignal ? ` (${exitSignal})` : ""}.`
      );
      const enriched = error as Error & {
        stdout?: string;
        stderr?: string;
        terminationReason?: "abort" | "timeout";
      };
      enriched.stdout = stdoutText;
      enriched.stderr = stderrText;
      enriched.terminationReason = control.reason();
      reject(enriched);
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}
