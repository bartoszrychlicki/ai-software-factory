import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFileControlled } from "./process-control";
import { findUpFile, getProject } from "./projects";
import { resolveRoute } from "./routing";

export interface PreflightDependency {
  linearStateNames(): Promise<string[]>;
  mastraUp(): Promise<boolean>;
  exec?(
    file: string,
    args: readonly string[],
    options?: { cwd?: string }
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface PreflightReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  localExactShaCi: boolean;
}

const engineBinary: Record<string, string> = {
  "claude-code": process.env.CLAUDE_BIN ?? "claude",
  codex: process.env.CODEX_BIN ?? "codex",
  "kimi-code": process.env.KIMI_BIN ?? "kimi",
  pi: process.env.PI_BIN ?? "pi",
};

/**
 * Odczytowy preflight przed claimem. Nie tworzy worktree, nie zmienia Lineara
 * i nie odpala modelu.
 */
export async function runPreflight(
  projectKey: string,
  dependency: PreflightDependency
): Promise<PreflightReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let localExactShaCi = false;
  const exec = dependency.exec ?? ((file, args, options) =>
    execFileControlled(file, args, { cwd: options?.cwd, timeoutMs: 30_000 }));

  const project = await getProject(projectKey).catch((error) => {
    errors.push(error instanceof Error ? error.message : String(error));
    return undefined;
  });
  if (!project) return { ok: false, errors, warnings, localExactShaCi };

  await access(project.repo).catch(() => errors.push(`Repo nie istnieje lub jest niedostępne: ${project.repo}`));
  if (project.security?.semgrep) {
    await exec("sh", ["-c", `command -v "$1" >/dev/null`, "preflight", "semgrep"])
      .catch(() => errors.push(
        `Projekt "${projectKey}" wymaga semgrep (security.semgrep), ale binarium nie jest w PATH.`
      ));
  }
  await exec("git", ["-C", project.repo, "remote", "get-url", "origin"])
    .catch((error) => errors.push(`Repo/remote origin: ${error instanceof Error ? error.message : error}`));
  await exec("gh", ["auth", "status"], { cwd: project.repo })
    .catch((error) => errors.push(`gh auth: ${error instanceof Error ? error.message : error}`));

  const stateNames: string[] = await dependency.linearStateNames().catch((error) => {
    errors.push(`Linear API: ${error instanceof Error ? error.message : error}`);
    return [];
  });
  for (const required of ["Todo", "In Progress", "In Review", "Done", "Canceled", "👤 ⛔ Zablokowany"]) {
    if (!stateNames.includes(required)) errors.push(`Linear: brak wymaganego stanu "${required}"`);
  }
  if (!await dependency.mastraUp()) errors.push("Mastra /workflows jest niedostępna.");

  const routes = await Promise.all([
    resolveRoute("plan", { project: projectKey }),
    resolveRoute("build", { project: projectKey }),
    resolveRoute("review", { project: projectKey }),
  ]).catch((error) => {
    errors.push(`Routing: ${error instanceof Error ? error.message : error}`);
    return [];
  });
  const checkedEngines = new Set<string>();
  const cliVersions: Record<string, string> = {};
  for (const route of routes) {
    if (checkedEngines.has(route.engine.name)) continue;
    checkedEngines.add(route.engine.name);
    const binary = engineBinary[route.engine.name] ?? route.engine.name;
    await exec("sh", ["-c", `command -v "$1" >/dev/null`, "preflight", binary])
      .catch(() => errors.push(`Brak binarium silnika ${route.engine.name}: ${binary}`));
    const probe = route.engine.name === "claude-code"
      ? ["auth", "status"]
      : route.engine.name === "codex"
        ? ["login", "status"]
        : ["--version"];
    try {
      const auth = await exec(binary, probe);
      if (route.engine.name === "claude-code") {
        const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean };
        if (parsed.loggedIn !== true) errors.push("claude-code nie jest zalogowany (claude auth status: loggedIn=false).");
      }
    } catch (error) {
      errors.push(
        `${route.engine.name} nie jest gotowy/autoryzowany: ${error instanceof Error ? error.message : error}`
      );
    }
    cliVersions[route.engine.name] = await exec(binary, ["--version"])
      .then(({ stdout }) => {
        const line = stdout.trim().split("\n")[0] ?? "";
        return line.match(/\d+\.\d+[^\s)]*/)?.[0] ?? (line || "unknown");
      })
      .catch(() => "unknown");
  }
  // Rejestr wersji harnessów: cichy auto-update CLI ma zostawić ślad ZANIM
  // zmieni first-pass-rate. Zmiana wersji = warning (raportowany przez poller).
  try {
    const versionsPath = join(dirname(findUpFile("package.json")), "runs", "cli-versions.json");
    const previous = await readFile(versionsPath, "utf8")
      .then((raw) => JSON.parse(raw) as Record<string, string>)
      .catch(() => ({} as Record<string, string>));
    let changed = false;
    for (const [engineName, version] of Object.entries(cliVersions)) {
      if (version === "unknown") continue;
      const before = previous[engineName];
      if (before && before !== version) {
        warnings.push(`Harness ${engineName} zmienił wersję: ${before} → ${version}.`);
      }
      if (before !== version) changed = true;
    }
    if (changed) {
      await mkdir(dirname(versionsPath), { recursive: true });
      await writeFile(versionsPath, JSON.stringify({ ...previous, ...cliVersions }, null, 2));
    }
  } catch {
    // rejestr wersji jest best-effort — nie blokuje preflightu
  }

  if (project.github) {
    const branch = project.default_branch ?? "main";
    try {
      const { stdout } = await exec(
        "gh",
        ["api", `repos/${project.github}/branches/${branch}/protection/required_status_checks`],
        { cwd: project.repo }
      );
      const protection = JSON.parse(stdout) as {
        strict?: boolean;
        contexts?: string[];
        checks?: { context?: string }[];
      };
      const actual = new Set([
        ...(protection.contexts ?? []),
        ...(protection.checks ?? []).map((check) => check.context ?? ""),
      ]);
      if (!protection.strict) errors.push(`${project.github}: required status checks nie mają strict=true.`);
      for (const check of project.ci?.requiredChecks ?? []) {
        if (!actual.has(check)) errors.push(`${project.github}: branch protection nie wymaga checka "${check}".`);
      }
    } catch (error) {
      if (projectKey === "br-budget") {
        localExactShaCi = true;
        warnings.push("br-budget: branch protection niedostępna; obowiązuje jeden lokalny exact-SHA check po synchronizacji z main.");
      } else {
        errors.push(`GitHub branch protection: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, localExactShaCi };
}
