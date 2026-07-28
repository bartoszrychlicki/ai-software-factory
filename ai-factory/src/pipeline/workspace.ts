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
}

// worktrees trzymamy POZA repo — zero śmieci w projekcie, łatwe sprzątanie
const ROOT = process.env.FACTORY_WORKTREES ?? join(homedir(), ".ai-factory", "worktrees");

export async function createWorkspace(
  repoPath: string,
  ticketId: string,
  slug: string,
  defaultBranch = "main",
  baseRef?: string
): Promise<Workspace> {
  const branch = `agent/${ticketId}-${slug}`;
  const dir = join(ROOT, basename(repoPath), ticketId);
  // Rozwiąż checkpoint przed usunięciem starej gałęzi, która może być jego
  // jedyną czytelną referencją. Sam obiekt commita pozostaje dostępny po SHA.
  const checkpoint = baseRef
    ? await exec("git", ["-C", repoPath, "rev-parse", "--verify", `${baseRef}^{commit}`])
        .then(({ stdout }) => stdout.trim())
        .catch(() => undefined)
    : undefined;

  // świeży katalog każdej próby, ale retry może bazować na ostatnim commicie
  // poprzedniej próby zamiast ponownie odtwarzać całą implementację od maina.
  await exec("git", ["-C", repoPath, "worktree", "remove", "--force", dir]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
  // prune PRZED branch -D: martwa rejestracja worktree trzyma gałąź jako
  // "checked out" i branch -D cicho pada → worktree add -b wywala się na
  // "branch already exists"
  await exec("git", ["-C", repoPath, "worktree", "prune"]).catch(() => {});
  await exec("git", ["-C", repoPath, "branch", "-D", branch]).catch(() => {});

  // BAZA = świeży origin/<default>, nie lokalny main: praca równoległa przesuwa maina
  // w trakcie builda, a odgałęzienie od nieaktualnego stanu = gwarantowany konflikt przy publish
  await exec("git", ["-C", repoPath, "fetch", "origin", defaultBranch]).catch(() => {});
  const base = checkpoint ?? await exec("git", ["-C", repoPath, "rev-parse", "--verify", `origin/${defaultBranch}`])
    .then(() => `origin/${defaultBranch}`)
    .catch(() => defaultBranch);
  await exec("git", ["-C", repoPath, "worktree", "add", "-b", branch, dir, base]);
  return { ticketId, branch, dir, repoPath };
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
