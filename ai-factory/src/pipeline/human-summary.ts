export const HUMAN_SUMMARY_HEADING = "Podsumowanie dla człowieka";
export const CRITIQUE_MEANING_HEADING = "Co to znaczy dla autora";

export const HUMAN_SUMMARY_CLIP_CHARS = 2_000;
export const CRITIQUE_MEANING_CLIP_CHARS = 500;

export interface ExtractedSection {
  body: string;
  /** Offset początku nagłówka sekcji w pełnym raporcie. */
  start: number;
  /** Offset początku następnej sekcji/bloku factory albo końca raportu. */
  end: number;
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clipped(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Deterministycznie odczytuje wyłącznie jawnie nazwaną sekcję Markdown.
 * Nie próbuje odgadywać streszczenia z prozy ani z kontraktu `factory`.
 */
export function extractSection(
  report: string | undefined,
  heading: string
): ExtractedSection | undefined {
  if (!report) return undefined;

  const headingPattern = new RegExp(
    `^[ \\t]{0,3}#{2,3}[ \\t]*${escapedRegex(heading)}[ \\t]*:?[ \\t]*$`,
    "mi"
  );
  const headingMatch = headingPattern.exec(report);
  if (!headingMatch || headingMatch.index === undefined) return undefined;

  const bodyStart = headingMatch.index + headingMatch[0].length;
  const remainder = report.slice(bodyStart);
  const boundaryMatch = /^[ \t]{0,3}(?:#{1,3}[ \t]+|```factory\b)/mi.exec(remainder);
  const end = boundaryMatch?.index === undefined
    ? report.length
    : bodyStart + boundaryMatch.index;
  const body = report.slice(bodyStart, end).trim();
  if (!body) return undefined;

  return {
    body,
    start: headingMatch.index,
    end,
  };
}

export function humanSummaryOf(report?: string): string | undefined {
  const section = extractSection(report, HUMAN_SUMMARY_HEADING);
  return section ? clipped(section.body, HUMAN_SUMMARY_CLIP_CHARS) : undefined;
}

export function critiqueMeaningOf(report?: string): string | undefined {
  const section = extractSection(report, CRITIQUE_MEANING_HEADING);
  if (!section) return undefined;
  const oneLine = section.body.replace(/\s*\n+\s*/g, " ").trim();
  return oneLine ? clipped(oneLine, CRITIQUE_MEANING_CLIP_CHARS) : undefined;
}

export function stripSection(report: string, heading: string): string {
  const section = extractSection(report, heading);
  if (!section) return report;
  return `${report.slice(0, section.start)}${report.slice(section.end)}`;
}
