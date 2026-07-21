
import { Mastra } from '@mastra/core/mastra';
import { DefaultExecutionEngine } from '@mastra/core/workflows';

// ŁATKA (bug @mastra/core ≤1.52-alpha): guard w persistStepUpdate odrzuca zapisy
// snapshotu ze statusem "running", dopóki in-process mapa pamięta "suspended" —
// czyszczoną dopiero na KOŃCU runa. Efekt: po resume Studio/API widzi approve-plan
// aż do finału. Nasz graf jest w pełni sekwencyjny (chroniony wyścig równoległych
// zapisów po suspend u nas nie występuje), więc neutralizujemy guard w prototypie
// (dziedziczy go też EventedExecutionEngine). Usunąć po fixie upstream.
(DefaultExecutionEngine.prototype as { getLastPersistedStatus: (runId: string) => undefined }).getLastPersistedStatus = () => undefined;
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from "@mastra/duckdb";
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, MastraStorageExporter, MastraPlatformExporter, SensitiveDataFilter } from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { weatherAgent } from './agents/weather-agent';
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';
import { ticketPipeline } from "../pipeline/ticket-pipeline";

export const mastra = new Mastra({
  workflows: { weatherWorkflow, ticketPipeline },
  agents: { weatherAgent },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: "mastra-storage",
      // Uses a hosted database when deployed (mastra env db create --kind turso),
      // and a local file during development.
      url: process.env.TURSO_DATABASE_URL ?? "file:./mastra.db",
      authToken: process.env.TURSO_AUTH_TOKEN,
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    }
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new MastraStorageExporter(), // Persists observability events to Mastra Storage
          new MastraPlatformExporter(), // Sends observability events to Mastra Platform (if MASTRA_PLATFORM_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
