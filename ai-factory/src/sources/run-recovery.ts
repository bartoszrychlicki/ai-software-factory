import * as registry from "../pipeline/run-registry";
import { parseCommand } from "./commands";
import type { LinearCommandCandidate } from "./linear";
import { isWorkflowRunMissing, type WorkflowControlClient } from "./mastra-client";

export class MissingRunDetector {
  private consecutive = 0;

  constructor(private readonly threshold = 3) {}

  observe(error: unknown): boolean {
    if (!isWorkflowRunMissing(error)) {
      this.consecutive = 0;
      return false;
    }
    this.consecutive += 1;
    return this.consecutive >= this.threshold;
  }

  reset(): void {
    this.consecutive = 0;
  }
}

export interface RestartSource {
  listCommandCandidates(): Promise<LinearCommandCandidate[]>;
  comment(id: string, body: string): Promise<void>;
  setStateByName(id: string, stateName: string): Promise<void>;
}

interface ProcessRestartOptions {
  project: string;
  source: RestartSource;
  client: WorkflowControlClient;
  readyState: string;
  factoryMarker: (ticketId: string) => string;
  log?: (message: string) => void;
}

const restartMarker = (commentId: string) => `[factory:restart:${commentId}]`;

/**
 * Globalna komenda operatorska. Działa także po finalizacji brakującego runu,
 * bo źródłem kandydatów jest Linear, nie lista unfinished z rejestru.
 */
export async function processRestartCommands(options: ProcessRestartOptions): Promise<string[]> {
  const restarted: string[] = [];
  const tickets = await options.source.listCommandCandidates();

  for (const ticket of tickets) {
    const initial = registry.readState(ticket.id);
    if (!initial || initial.project !== options.project || initial.prUrl) continue;

    for (const comment of ticket.comments) {
      if (comment.createdAt < initial.createdAt || comment.body.includes(options.factoryMarker(ticket.id))) continue;
      const command = parseCommand(comment.body);
      if (command?.kind !== "restart") continue;

      const seed = { project: initial.project, runId: initial.runId };
      let record = registry.observeRestartCommand(ticket.id, seed, {
        commentId: comment.id,
        payload: command.payload,
        observedAt: comment.createdAt,
      });
      if (!record || record.handledAt) continue;

      if (!record.cancelConfirmedAt) {
        try {
          await options.client.cancelRun(initial.runId);
        } catch (error) {
          if (!isWorkflowRunMissing(error)) {
            registry.markRestartError(
              ticket.id,
              seed,
              comment.id,
              error instanceof Error ? error.message : String(error)
            );
            continue;
          }
        }
        registry.markRestartStep(ticket.id, seed, comment.id, "cancelConfirmedAt");
        record = registry.readState(ticket.id)?.restartCommands?.[comment.id];
      }

      registry.finalize(ticket.id, seed, "orphan", "restart");

      const auditMarker = restartMarker(comment.id);
      if (!record?.auditCommentedAt) {
        const alreadyCommented = ticket.comments.some((candidate) => candidate.body.includes(auditMarker));
        if (!alreadyCommented) {
          const reason = command.payload ? ` Powód operatora: ${command.payload}` : "";
          await options.source.comment(
            ticket.id,
            `🔄 Force restart przyjęty ${options.factoryMarker(ticket.id)} ${auditMarker}.` +
              `${reason}\nStary run \`${initial.runId}\` został unieważniony. Ticket wraca do świeżego planowania.`
          );
        }
        registry.markRestartStep(ticket.id, seed, comment.id, "auditCommentedAt");
      }

      await options.source.setStateByName(ticket.id, options.readyState);
      registry.markRestartStep(ticket.id, seed, comment.id, "readyAt");
      registry.markRestartStep(ticket.id, seed, comment.id, "handledAt");
      options.log?.(`[${ticket.id}] force restart z Linear — stary run ${initial.runId} unieważniony`);
      restarted.push(ticket.id);
    }
  }

  return restarted;
}
