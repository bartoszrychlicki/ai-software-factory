import type { LifecycleRun } from "./lifecycle-store";

/**
 * Serializacja kolizji plikowych między ticketami (semantyka BAR-141 w v2):
 * build ticketu czeka, gdy inny zatwierdzony run tego samego projektu trzyma
 * te same pliki od aprobaty do domknięcia PR-a. Run bez zadeklarowanych plików
 * działa jak wildcard (konserwatywnie, jak w v1).
 */
const HOLDING_STAGES = new Set(["build", "test", "publish", "ci", "review", "merge"]);

export interface PlanFileCollision {
  ticketId: string;
  files: string[];
}

export function planFileCollisions(
  candidate: LifecycleRun,
  others: LifecycleRun[]
): PlanFileCollision[] {
  const candidateFiles = new Set(candidate.planFiles);
  const candidateOrder = `${candidate.approvedAt ?? candidate.createdAt}:${candidate.ticketId}`;
  const collisions: PlanFileCollision[] = [];
  for (const other of others) {
    if (other.ticketId === candidate.ticketId || other.project !== candidate.project) continue;
    if (!HOLDING_STAGES.has(other.stage)) continue;
    if (other.status === "blocked" || other.status === "done") continue;
    if (!other.approvedAt) continue;
    // Tie-break dwóch świeżo zatwierdzonych buildów: wcześniejsza aprobata
    // (a przy remisie niższy ticketId) jedzie pierwsza — inaczej oba czekałyby
    // na siebie nawzajem w nieskończoność.
    if (other.stage === "build" && candidate.stage === "build") {
      const otherOrder = `${other.approvedAt}:${other.ticketId}`;
      if (otherOrder > candidateOrder) continue;
    }
    if (!candidate.planFiles.length || !other.planFiles.length) {
      collisions.push({ ticketId: other.ticketId, files: ["*"] });
      continue;
    }
    const overlap = other.planFiles.filter((file) => candidateFiles.has(file));
    if (overlap.length) collisions.push({ ticketId: other.ticketId, files: overlap });
  }
  return collisions;
}
