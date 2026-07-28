import { createHash } from "node:crypto";
import { parseCommand } from "./commands";
import type { LinearComment } from "./linear";

export interface RelevantComment {
  body: string;
  createdAt: string;
}

export interface CommentContextSnapshot {
  context: string;
  effectiveInputHash: string;
  totalRelevant: number;
  includedCount: number;
  truncated: boolean;
  comments: RelevantComment[];
}

export const DEFAULT_COMMENT_LIMIT = 20;
export const DEFAULT_COMMENT_CHARS = 12_000;

const factoryMarker = (ticketId: string) => `[linear:${ticketId}:v1]`;

/**
 * Komentarze autora są danymi planowania, ale komendy i komentarze fabryki
 * pozostają kanałem sterowania/audytu. Payload /answer i /reject jest treścią
 * merytoryczną, więc zachowujemy go bez tokenu komendy.
 */
export function extractRelevantComments(
  comments: readonly Pick<LinearComment, "body" | "createdAt">[],
  ticketId: string
): RelevantComment[] {
  return comments
    .flatMap((comment): RelevantComment[] => {
      const body = comment.body.trim();
      if (!body || body.includes(factoryMarker(ticketId))) return [];
      const command = parseCommand(body);
      if (!command) return [{ body, createdAt: comment.createdAt }];
      if ((command.kind === "answer" || command.kind === "reject") && command.payload) {
        return [{ body: command.payload.trim(), createdAt: comment.createdAt }];
      }
      return [];
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function buildCommentContextSnapshot(
  ticketId: string,
  title: string,
  description: string,
  rawComments: readonly Pick<LinearComment, "body" | "createdAt">[],
  options: { maxComments?: number; maxChars?: number } = {}
): CommentContextSnapshot {
  const relevant = extractRelevantComments(rawComments, ticketId);
  const maxComments = options.maxComments ?? DEFAULT_COMMENT_LIMIT;
  const maxChars = options.maxChars ?? DEFAULT_COMMENT_CHARS;
  const selected: RelevantComment[] = [];
  let chars = 0;
  let contentTruncated = false;

  // Najnowsze decyzje wygrywają. Po wyborze przywracamy kolejność chronologiczną.
  for (const comment of [...relevant].reverse()) {
    if (selected.length >= maxComments) break;
    const available = maxChars - chars;
    if (available <= 0) break;
    const body = comment.body.length <= available
      ? comment.body
      : comment.body.slice(0, available).trimEnd();
    if (body.length < comment.body.length) contentTruncated = true;
    if (body) {
      selected.push({ ...comment, body });
      chars += body.length;
    }
  }
  selected.reverse();

  const truncated = contentTruncated || selected.length < relevant.length;
  const commentBody = selected
    .map((comment, index) => `## Komentarz autora ${index + 1} (${comment.createdAt})\n${comment.body}`)
    .join("\n\n");
  const context = selected.length
    ? [
        "# Istotne komentarze autora (snapshot z chwili claimu)",
        truncated
          ? `> Uwaga: kontekst ograniczono deterministycznie; użyto ${selected.length} z ${relevant.length} komentarzy.`
          : `> Użyto ${selected.length} komentarzy w kolejności chronologicznej.`,
        "",
        commentBody,
      ].join("\n")
    : "";

  const effectiveInputHash = createHash("sha256")
    .update(JSON.stringify({
      title: title.trim(),
      description: description.trim(),
      comments: selected,
      totalRelevant: relevant.length,
      truncated,
    }))
    .digest("hex");

  return {
    context,
    effectiveInputHash,
    totalRelevant: relevant.length,
    includedCount: selected.length,
    truncated,
    comments: selected,
  };
}
