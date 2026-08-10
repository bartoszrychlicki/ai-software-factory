import type { OutboxCommand } from "./run-registry";
import * as registry from "./run-registry";
import {
  runStatus,
  suspendedPath,
  type MastraRunSnapshot,
  type WorkflowControlClient,
} from "../adapters/mastra/client";

const samePath = (a: string | string[] | undefined, b: string[] | undefined): boolean => {
  const left = Array.isArray(a) ? a : a ? [a] : [];
  return !!b && left.length === b.length && left.every((part, index) => part === b[index]);
};

/** Flushes the durable v1 outbox. Kept only for legacy recovery and tests. */
export async function dispatchPendingOutbox(
  client: WorkflowControlClient,
  ticketId: string,
  seed: { project: string; runId: string }
): Promise<void> {
  for (const command of registry.pendingOutbox(ticketId)) {
    try {
      if (command.kind === "start") {
        await client.startRun(seed.runId, command.body);
      } else {
        if (!command.step) throw new Error(`Komenda ${command.id} resume nie ma ścieżki kroku`);
        await client.resumeRun(seed.runId, command.step, command.body);
      }
      registry.markOutboxAttempt(ticketId, seed, command.id, { dispatched: true });
      if (command.gate !== undefined && command.round !== undefined) {
        registry.markDecisionStep(ticketId, seed, command.gate, command.round, "resumeSentAt");
      }
    } catch (err) {
      registry.markOutboxAttempt(ticketId, seed, command.id, {
        dispatched: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Confirms a v1 outbox command from workflow progress rather than fetch alone. */
export function acknowledgeOutboxFromRun(
  ticketId: string,
  seed: { project: string; runId: string },
  run: MastraRunSnapshot
): void {
  const state = registry.readState(ticketId);
  if (!state) return;
  const status = runStatus(run);
  const currentPath = suspendedPath(run);
  for (const command of Object.values(state.outbox ?? {})) {
    if (command.state !== "dispatched") continue;
    const acknowledged = command.kind === "start"
      ? status !== "pending" && status !== "unknown"
      : status !== "suspended" || !samePath(command.step, currentPath);
    if (!acknowledged) continue;
    registry.acknowledgeOutbox(ticketId, seed, command.id);
    if (command.gate !== undefined && command.round !== undefined) {
      registry.markDecisionStep(ticketId, seed, command.gate, command.round, "resumeAckedAt");
    }
  }
}

export function outboxId(kind: OutboxCommand["kind"], suffix: string): string {
  return `${kind}:${suffix}`;
}
