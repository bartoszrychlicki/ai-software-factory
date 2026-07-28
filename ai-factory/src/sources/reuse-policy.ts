import { createHash } from "node:crypto";
import type { TicketState } from "../pipeline/run-registry";
import type { RelevantComment } from "./comment-context";

export interface ApprovalInputIdentity {
  approved?: boolean;
  at?: string;
  descriptionHash?: string;
  effectiveInputHash?: string;
}

export function approvalMatchesInput(
  approval: ApprovalInputIdentity,
  description: string,
  effectiveInputHash: string,
  relevantComments: readonly RelevantComment[]
): boolean {
  if (approval.effectiveInputHash) return approval.effectiveInputHash === effectiveInputHash;
  if (
    approval.descriptionHash &&
    approval.descriptionHash !== createHash("sha256").update(description).digest("hex")
  ) {
    return false;
  }

  // Legacy approval znał tylko opis. Istotny komentarz nowszy niż aprobata
  // unieważnia plan; brak timestampu przy istniejących komentarzach = fail-closed.
  if (!relevantComments.length) return true;
  if (!approval.at) return false;
  return !relevantComments.some((comment) => comment.createdAt > approval.at!);
}

export function decideMergeReopenOutcome(
  state: TicketState | undefined,
  effectiveInputHash: string,
  mergedRunHash: string | undefined
): "no-scope" | "proceed" {
  if (
    state?.mergeHandledAt &&
    state.finalized?.outcome === "success" &&
    mergedRunHash &&
    mergedRunHash === effectiveInputHash
  ) {
    return "no-scope";
  }
  return "proceed";
}
