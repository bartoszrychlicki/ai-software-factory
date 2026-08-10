import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

interface ProjectEntry {
  repo?: unknown;
  checks?: unknown;
  github?: unknown;
  ci?: { requiredChecks?: unknown };
}

const root = process.cwd();
const ci = process.argv.includes("--ci");
const failures: string[] = [];
const warnings: string[] = [];

function ok(message: string): void {
  console.log(`✓ ${message}`);
}

function fail(message: string): void {
  failures.push(message);
  console.error(`✗ ${message}`);
}

function warn(message: string): void {
  warnings.push(message);
  console.warn(`! ${message}`);
}

function readYamlFile(name: string): Record<string, unknown> | undefined {
  const file = join(root, name);
  if (!existsSync(file)) {
    fail(`Missing ${name}; run the doctor from the repository root.`);
    return undefined;
  }
  try {
    const value = parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`${name} must contain a YAML mapping.`);
      return undefined;
    }
    ok(`${name} parses correctly`);
    return value as Record<string, unknown>;
  } catch (error) {
    fail(`${name} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major > 22 || (major === 22 && minor >= 18)) ok(`Node ${process.versions.node}`);
else fail(`Node >=22.18.0 is required; found ${process.versions.node}`);

const git = spawnSync("git", ["--version"], { encoding: "utf8" });
if (git.status === 0) ok(git.stdout.trim());
else fail("git is required and was not found in PATH");

for (const name of [
  "package.json",
  "package-lock.json",
  ".env.example",
  "routing.yaml",
  "projects.local.example.yaml",
  "routing.local.example.yaml",
]) {
  if (existsSync(join(root, name))) ok(`${name} found`);
  else fail(`${name} is missing`);
}

const projects = readYamlFile("projects.yaml");
if (projects) {
  for (const [key, raw] of Object.entries(projects)) {
    const project = raw as ProjectEntry;
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      fail(`projects.yaml: ${key} must be a mapping`);
      continue;
    }
    if (typeof project.repo !== "string" || !project.repo.trim()) {
      fail(`projects.yaml: ${key}.repo must be a non-empty path`);
    } else if (isAbsolute(project.repo)) {
      fail(`projects.yaml: ${key}.repo must be portable (use a relative path; override it in projects.local.yaml)`);
    }
    if (!Array.isArray(project.checks) || project.checks.length === 0) {
      fail(`projects.yaml: ${key}.checks must contain at least one deterministic command`);
    }
    if (
      typeof project.github === "string" &&
      (!Array.isArray(project.ci?.requiredChecks) || project.ci.requiredChecks.length === 0)
    ) {
      fail(`projects.yaml: ${key} has GitHub configured without ci.requiredChecks`);
    }
  }
  if (!failures.length) ok("committed project configuration is portable and fail-closed");
}

readYamlFile("routing.yaml");
readYamlFile("projects.local.example.yaml");
readYamlFile("routing.local.example.yaml");

if (!existsSync(join(root, ".env"))) {
  warn("No .env file. This is fine for tests and Studio; copy .env.example before running the live Linear poller.");
}
if (!existsSync(join(root, "projects.local.yaml"))) {
  warn("No projects.local.yaml. Committed relative paths are examples; create a local override for real repositories.");
}

if (failures.length) {
  console.error(`\nDoctor found ${failures.length} blocking problem(s).`);
  process.exitCode = 1;
} else {
  console.log(`\nRepository baseline is ready${ci ? " for CI" : " for local exploration"}.`);
  if (warnings.length) console.log("Live polling still requires the optional host configuration listed above.");
}
