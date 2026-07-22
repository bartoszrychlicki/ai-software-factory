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
  defaultBranch = "main"
): Promise<Workspace> {
  const branch = `agent/${ticketId}-${slug}`;
  const dir = join(ROOT, basename(repoPath), ticketId);

  // świeży start każdej próby: sprzątnij pozostałości poprzedniej
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
  const base = await exec("git", ["-C", repoPath, "rev-parse", "--verify", `origin/${defaultBranch}`])
    .then(() => `origin/${defaultBranch}`)
    .catch(() => defaultBranch);
  await exec("git", ["-C", repoPath, "worktree", "add", "-b", branch, dir, base]);
  return { ticketId, branch, dir, repoPath };
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