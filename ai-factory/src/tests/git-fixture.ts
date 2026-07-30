import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** Minimalne repo z działającym origin/main dla testów jobów read-only. */
export function createTestGitRepo(root: string, name = "planning-repo"): string {
  const remote = join(root, `${name}-origin.git`);
  const repo = join(root, name);
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "factory@example.test");
  git(repo, "config", "user.name", "Factory Test");
  writeFileSync(join(repo, "fixture.txt"), "fixture\n");
  git(repo, "add", "fixture.txt");
  git(repo, "commit", "-m", "test fixture");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  return repo;
}

/** Kieruje disposable worktree'y testu do jego własnego katalogu tymczasowego. */
export function useTestWorktrees(root: string): () => void {
  const previous = process.env.FACTORY_WORKTREES;
  process.env.FACTORY_WORKTREES = join(root, "worktrees");
  return () => {
    if (previous === undefined) delete process.env.FACTORY_WORKTREES;
    else process.env.FACTORY_WORKTREES = previous;
  };
}
