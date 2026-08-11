import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LinearSource } from "../adapters/linear/client";
import {
  findUpFile,
  getProject,
  type ProjectConfig,
} from "../config/projects";
import { readLocalOverride, readYamlMapping } from "../config/local-config";
import { LifecycleStore } from "../lifecycle/store";
import { breakerSnapshot } from "../observability/breaker";
import {
  createFactoryTools,
  type FactoryToolDependencies,
} from "./tools";

const TOOL_VERSION = "1.0.0";

type ToolAction = () => Promise<unknown>;

async function callTool(action: ToolAction) {
  try {
    const value = await action();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      }],
      isError: true,
    };
  }
}

export function buildFactoryMcpServer(deps: FactoryToolDependencies): McpServer {
  const tools = createFactoryTools(deps);
  const server = new McpServer({ name: "ai-factory", version: TOOL_VERSION });

  server.registerTool("factory_projects", {
    description: "Lista projektów widocznych dla lokalnej fabryki i ich bezpiecznej konfiguracji.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => callTool(() => tools.factoryProjects()));

  server.registerTool("factory_health", {
    description: "Stan bezpiecznika, lease pollera, aktywnych runów i kosztu z ostatniej godziny.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => callTool(() => tools.factoryHealth()));

  server.registerTool("queue_overview", {
    description: "Aktywna kolejka fabryki: etap, status, otwarta bramka, właściciel piłki i wiek.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => callTool(() => tools.queueOverview()));

  server.registerTool("ticket_status", {
    description: "Pełny status durable runu ticketu wraz z budżetem i komendami dostępnymi człowiekowi.",
    inputSchema: {
      ticket: z.string().trim().min(1).describe("Identyfikator ticketu, np. BAR-200"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => callTool(() => tools.ticketStatus(input)));

  server.registerTool("ticket_plan", {
    description: "Plan bieżącej generacji, podsumowanie dla człowieka, triage, krytyka i briefy researchu.",
    inputSchema: {
      ticket: z.string().trim().min(1).describe("Identyfikator ticketu, np. BAR-200"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => callTool(() => tools.ticketPlan(input)));

  server.registerTool("ticket_attempts", {
    description: "Chronologiczna lista prób etapów ticketu z opcjonalnym, clipowanym ogonem raportu.",
    inputSchema: {
      ticket: z.string().trim().min(1).describe("Identyfikator ticketu, np. BAR-200"),
      includeReportTail: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input) => callTool(() => tools.ticketAttempts(input)));

  server.registerTool("ticket_create", {
    description: "Tworzy issue w backlogu Lineara. Nie oddaje go automatycznie fabryce.",
    inputSchema: {
      project: z.string().trim().min(1),
      title: z.string().trim().min(1),
      description: z.string().optional(),
      labels: z.array(z.string().trim().min(1)).optional().default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (input) => callTool(() => tools.ticketCreate(input)));

  server.registerTool("ticket_enqueue", {
    description: "Jawnie przenosi istniejący ticket z Backlogu do Todo; domyślnie wyłączone flagą.",
    inputSchema: {
      project: z.string().trim().min(1),
      ticket: z.string().trim().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (input) => callTool(() => tools.ticketEnqueue(input)));

  server.registerTool("ticket_comment", {
    description: "Dodaje zwykły komentarz do issue; próby komend i decyzji są odrzucane fail-closed.",
    inputSchema: {
      project: z.string().trim().min(1),
      ticket: z.string().trim().min(1),
      body: z.string().trim().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (input) => callTool(() => tools.ticketComment(input)));

  return server;
}

export function loadDotEnv(
  path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env")
): void {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2];
    }
  } catch {
    // Env procesu jest wystarczający.
  }
}

async function loadProjects(): Promise<Record<string, ProjectConfig>> {
  const basePath = findUpFile("projects.yaml");
  const base = await readYamlMapping(basePath);
  const local = await readLocalOverride(basePath);
  const configuredKeys = [...new Set([
    ...Object.keys(base),
    ...Object.keys(local ?? {}),
  ])];
  const selectedRaw = process.env.LINEAR_PROJECTS ?? process.env.LINEAR_PROJECT;
  const selectedKeys = selectedRaw
    ? selectedRaw.split(",").map((value) => value.trim()).filter(Boolean)
    : configuredKeys;
  const entries = await Promise.all(
    selectedKeys.map(async (key) => [key, await getProject(key)] as const)
  );
  return Object.fromEntries(entries);
}

async function main(): Promise<void> {
  loadDotEnv();
  const projects = await loadProjects();
  const apiKey = process.env.LINEAR_API_KEY;
  const linear = new Map<string, LinearSource>();
  let store: LifecycleStore | undefined;
  const deps: FactoryToolDependencies = {
    get store() {
      store ??= new LifecycleStore(undefined, { readOnly: true });
      return store;
    },
    projects,
    linearFor(project) {
      if (!apiKey) return undefined;
      let source = linear.get(project);
      if (!source) {
        source = new LinearSource(apiKey, project);
        linear.set(project, source);
      }
      return source;
    },
    breaker: async () => breakerSnapshot(),
    now: () => new Date(),
    allowEnqueue: process.env.FACTORY_MCP_ALLOW_ENQUEUE === "on",
  };
  const server = buildFactoryMcpServer(deps);
  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } finally {
      store?.close();
      process.exit(exitCode);
    }
  };
  process.once("SIGINT", () => { void shutdown(130); });
  process.once("SIGTERM", () => { void shutdown(143); });
  process.once("exit", () => {
    try {
      store?.close();
    } catch {
      // Połączenie mogło zostać już zamknięte przez handler sygnału.
    }
  });
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
