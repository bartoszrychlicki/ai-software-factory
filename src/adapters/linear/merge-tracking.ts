export interface MergeTrackingState {
  lifecycle?: "running" | "awaiting_decision" | "finalized";
  finalized?: {
    outcome: "success" | "blocked" | "failed" | "rejected" | "orphan";
  };
  prUrl?: string;
}

interface MergeTrackingComment {
  body: string;
}

/**
 * A durable run may enter the review phase before its GitHub CI gate finishes.
 * In that window old Linear comments can contain URLs of already merged PRs.
 * Only the PR persisted by the current successful run is safe to track.
 *
 * The comment fallback is intentionally limited to legacy tickets that have no
 * durable registry entry at all.
 */
export function currentTrackedPrUrl(
  state: MergeTrackingState | undefined,
  comments: readonly MergeTrackingComment[],
  factoryMarker: string
): string | undefined {
  if (state) {
    if (
      state.lifecycle !== "finalized" ||
      state.finalized?.outcome !== "success" ||
      !state.prUrl
    ) {
      return undefined;
    }
    return state.prUrl;
  }

  return comments
    .filter((comment) => comment.body.includes(factoryMarker))
    .map((comment) => comment.body.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0])
    .filter((url): url is string => !!url)
    .at(-1);
}
