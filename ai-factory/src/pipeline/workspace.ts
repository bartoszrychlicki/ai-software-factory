import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { rm } from "node:fs/promises";

const exec = promisify(execFile);

export interface Workspace {
  ticketId: string;
  branch: string;
  dir: string;
  repoPath: string;
  /**
   * SHA checkpointu po bezkonfliktowym nałożeniu na świeży origin/main albo
   * wierzchołek opublikowanej gałęzi w trybie continue-branch.
   */
  checkpointSha?: string;
}

export interface WorkspaceOptions {
  /**
   * "fresh-main" (domyślny): worktree od świeżego origin/<default>, checkpoint
   * nakładany cherry-pickiem. "continue-branch" (/fix): worktree na wierzchołku
   * opublikowanej gałęzi, dzięki czemu kolejny push jest fast-forward.
   * Synchronizację z mainem wykonuje etap testów.
   */
  mode?: "fresh-main" | "continue-branch";
  /** Wymagana w continue-branch: dokładna nazwa opublikowanej gałęzi. */
  branch?: string;
}

// worktrees trzymamy POZA repo — zero śmieci w projekcie, łatwe sprzątanie
const ROOT = process.env.FACTORY_WORKTREES ?? join(homedir(), ".ai-factory", "worktrees");

export async function createWorkspace(
  repoPath: string,
  ticketId: string,
  slug: string,
  defaultBranch = "main",
  baseRef?: string,
  options: WorkspaceOptions = {}
): Promise<Workspace> {
  const mode = options.mode ?? "fresh-main";
  const branch = mode === "continue-branch"
    ? options.branch
    : `agent/${ticketId}-${slug}`;
  if (!branch) {
    throw new Error("FIX_BASE_INVALID: /fix wymaga nazwy opublikowanej gałęzi.");
  }
  const dir = join(ROOT, basename(repoPath), ticketId);
  // Rozwiąż checkpoint przed usunięciem starej gałęzi, która może być jego
  // jedyną czytelną referencją. Sam obiekt commita pozostaje dostępny po SHA.
  const checkpoint = baseRef
    ? await exec("git", ["-C", repoPath, "rev-parse", "--verify", `${baseRef}^{commit}`])
        .then(({ stdout }) => stdout.trim())
        .catch(() => undefined)
    : undefined;

  if (mode === "continue-branch") {
    if (!baseRef || !checkpoint) {
      throw new Error(
        "FIX_BASE_INVALID: /fix wymaga opublikowanego SHA poprzedniego checkpointu."
      );
    }
    await exec("git", ["-C", repoPath, "fetch", "origin", branch]).catch(() => {
      throw new Error(
        `FIX_BASE_MISSING: zdalna gałąź ${branch} nie istnieje; zamknij PR i użyj /replan.`
      );
    });
    const remoteTip = await exec(
      "git",
      ["-C", repoPath, "ls-remote", "--heads", "origin", branch]
    ).then(({ stdout }) => stdout.trim().split(/\s+/)[0] || undefined);
    if (!remoteTip) {
      throw new Error(
        `FIX_BASE_MISSING: zdalna gałąź ${branch} nie istnieje; zamknij PR i użyj /replan.`
      );
    }
    if (remoteTip !== checkpoint) {
      throw new Error(
        `BRANCH_DIVERGED: gałąź ${branch} wskazuje ${remoteTip.slice(0, 7)}, ` +
          `ale fabryka ostatnio opublikowała ${checkpoint.slice(0, 7)}; ` +
          "zamknij PR i użyj /replan."
      );
    }

    await exec("git", ["-C", repoPath, "worktree", "remove", "--force", dir]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
    await exec("git", ["-C", repoPath, "worktree", "prune"]).catch(() => {});
    await exec("git", ["-C", repoPath, "branch", "-D", branch]).catch(() => {});
    await exec("git", ["-C", repoPath, "worktree", "add", "-b", branch, dir, remoteTip]);
    return {
      ticketId,
      branch,
      dir,
      repoPath,
      checkpointSha: remoteTip,
    };
  }

  // świeży katalog każdej próby, ale retry może bazować na ostatnim commicie
  // poprzedniej próby zamiast ponownie odtwarzać całą implementację od maina.
  await exec("git", ["-C", repoPath, "worktree", "remove", "--force", dir]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
  // prune PRZED branch -D: martwa rejestracja worktree trzyma gałąź jako
  // "checked out" i branch -D cicho pada → worktree add -b wywala się na
  // "branch already exists"
  await exec("git", ["-C", repoPath, "worktree", "prune"]).catch(() => {});
  await exec("git", ["-C", repoPath, "branch", "-D", branch]).catch(() => {});

  // BAZA zawsze = świeży origin/<default>. Checkpoint jest zmianą kandydata,
  // nie bazą: nakładamy go na aktualny main i odrzucamy przy konflikcie.
  await exec("git", ["-C", repoPath, "fetch", "origin", defaultBranch]).catch(() => {});
  const base = await exec("git", ["-C", repoPath, "rev-parse", "--verify", `origin/${defaultBranch}`])
    .then(() => `origin/${defaultBranch}`)
    .catch(() => defaultBranch);
  await exec("git", ["-C", repoPath, "worktree", "add", "-b", branch, dir, base]);
  let checkpointSha: string | undefined;
  if (checkpoint) {
    try {
      await exec("git", ["-C", dir, "cherry-pick", checkpoint]);
      checkpointSha = await exec("git", ["-C", dir, "rev-parse", "HEAD"])
        .then(({ stdout }) => stdout.trim());
    } catch {
      // Konflikt lub pusty cherry-pick = checkpoint nie jest bezpiecznie
      // przenośny na aktualny main. Disposable worktree wraca do czystej bazy.
      await exec("git", ["-C", dir, "cherry-pick", "--abort"]).catch(() => {});
      await exec("git", ["-C", dir, "reset", "--hard", base]);
    }
  }
  return { ticketId, branch, dir, repoPath, checkpointSha };
}

/**
 * Checkpoint z poprzedniego buildu wolno przenieść do nowego planu wyłącznie,
 * gdy cały jego diff względem main mieści się w aktualnie zatwierdzonym scope.
 */
export async function checkpointWithinScope(
  repoPath: string,
  checkpointRef: string | undefined,
  declaredFiles: string[],
  defaultBranch = "main"
): Promise<string | undefined> {
  if (!checkpointRef) return undefined;
  await exec("git", ["-C", repoPath, "fetch", "origin", defaultBranch]).catch(() => {});
  const checkpoint = await exec(
    "git",
    ["-C", repoPath, "rev-parse", "--verify", `${checkpointRef}^{commit}`]
  ).then(({ stdout }) => stdout.trim()).catch(() => undefined);
  if (!checkpoint) return undefined;
  const base = await exec("git", ["-C", repoPath, "rev-parse", "--verify", `origin/${defaultBranch}`])
    .then(() => `origin/${defaultBranch}`)
    .catch(() => defaultBranch);
  const { stdout } = await exec(
    "git",
    ["-C", repoPath, "diff", "--name-only", "-z", `${base}...${checkpoint}`],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  const allowed = new Set(declaredFiles.map((file) => file.trim().replace(/^\.\//, "")).filter(Boolean));
  const changed = stdout.split("\0").map((file) => file.trim().replace(/^\.\//, "")).filter(Boolean);
  return changed.every((file) => allowed.has(file)) ? checkpoint : undefined;
}

export async function removeWorkspace(ws: Workspace): Promise<void> {
  await exec("git", ["-C", ws.repoPath, "worktree", "remove", "--force", ws.dir]).catch(() => {});
  await exec("git", ["-C", ws.repoPath, "branch", "-D", ws.branch]).catch(() => {});
}

/**
 * Świeży, oddzielny checkout konkretnego SHA (detached) — dla verifiera.
 * Weryfikujemy dokładny commit, nie brudny katalog buildera.
 */
export async function createCheckout(
  repoPath: string,
  ref: string,
  name: string
): Promise<{ dir: string }> {
  const dir = join(ROOT, basename(repoPath), name);
  await exec("git", ["-C", repoPath, "worktree", "remove", "--force", dir]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
  // sprzątnij martwe rejestracje (katalog skasowany, wpis w .git został)
  await exec("git", ["-C", repoPath, "worktree", "prune"]).catch(() => {});
  await exec("git", ["-C", repoPath, "worktree", "add", "--detach", dir, ref]);
  return { dir };
}

export async function removeCheckout(repoPath: string, dir: string): Promise<void> {
  await exec("git", ["-C", repoPath, "worktree", "remove", "--force", dir]).catch(() => {});
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
