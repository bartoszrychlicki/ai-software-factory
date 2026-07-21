import type { FactoryStatus, Ticket, TicketSource } from "./types";

const API = "https://api.linear.app/graphql";
const READY_LABEL = "agent:ready";

/** Mapowanie statusów fabryki na TYPY stanów Lineara (nazwy stanów są per team). */
const STATUS_TO_STATE_TYPE: Record<FactoryStatus, string> = {
  in_progress: "started",
  needs_clarification: "unstarted",
  blocked: "unstarted",
  human_review: "started", // preferujemy stan o nazwie "In Review", patrz pickState
  done: "completed",
};

interface LinearIssue {
  id: string; // UUID — wymagany przez mutacje
  identifier: string; // np. BAR-95
  title: string;
  description: string | null;
  url: string;
  priorityLabel: string | null;
  labels: { nodes: { id: string; name: string }[] };
  state: { id: string; name: string; type: string };
  team: { states: { nodes: { id: string; name: string; type: string }[] } };
}

export class LinearSource implements TicketSource {
  name = "linear";

  constructor(
    private apiKey: string,
    /** Nazwa projektu w Linear — musi odpowiadać kluczowi w projects.yaml. */
    private project: string
  ) {}

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      // twardy timeout: zawieszony socket bez niego wiesza CAŁĄ pętlę pollera w ciszy (2026-07-22)
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || json.errors?.length) {
      throw new Error(`Linear API: ${json.errors?.map((e) => e.message).join("; ") ?? res.statusText}`);
    }
    return json.data as T;
  }

  private issueFields = `
    id identifier title description url priorityLabel
    labels { nodes { id name } }
    state { id name type }
    team { states { nodes { id name type } } }
  `;

  private async fetchIssue(identifier: string): Promise<LinearIssue> {
    const data = await this.gql<{ issue: LinearIssue }>(
      `query($id: String!) { issue(id: $id) { ${this.issueFields} } }`,
      { id: identifier }
    );
    return data.issue;
  }

  async listReady(): Promise<Ticket[]> {
    const data = await this.gql<{ issues: { nodes: LinearIssue[] } }>(
      `query($filter: IssueFilter) { issues(filter: $filter, first: 25) { nodes { ${this.issueFields} } } }`,
      {
        filter: {
          project: { name: { eq: this.project } },
          labels: { name: { eq: READY_LABEL } },
          state: { type: { in: ["backlog", "unstarted"] } },
        },
      }
    );
    return data.issues.nodes.map((i) => ({
      id: i.identifier,
      source: this.name,
      title: i.title,
      description: i.description ?? "",
      labels: i.labels.nodes.map((l) => l.name).filter((n) => n !== READY_LABEL),
      priority: i.priorityLabel ?? undefined,
      url: i.url,
    }));
  }

  /** Zdejmuje label-trigger i przestawia na "started" — ponowny poll już ticketu nie zobaczy. */
  async claim(id: string): Promise<void> {
    const issue = await this.fetchIssue(id);
    const labelIds = issue.labels.nodes.filter((l) => l.name !== READY_LABEL).map((l) => l.id);
    const started = pickState(issue.team.states.nodes, "started", "In Progress");
    await this.gql(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issue.id, input: { labelIds, stateId: started.id } }
    );
  }

  async setStatus(id: string, status: FactoryStatus): Promise<void> {
    const issue = await this.fetchIssue(id);
    const preferredName = status === "human_review" ? "In Review" : status === "in_progress" ? "In Progress" : undefined;
    const state = pickState(issue.team.states.nodes, STATUS_TO_STATE_TYPE[status], preferredName);
    await this.gql(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issue.id, input: { stateId: state.id } }
    );
  }

  /** Issues projektu w danym stanie, z komentarzami — dla merge-watchera i adopcji sierot. */
  async listWithComments(
    stateName: string
  ): Promise<{ id: string; comments: { body: string; createdAt: string }[] }[]> {
    const data = await this.gql<{
      issues: { nodes: { identifier: string; comments: { nodes: { body: string; createdAt: string }[] } }[] };
    }>(
      `query($filter: IssueFilter) { issues(filter: $filter, first: 50) {
        nodes { identifier comments { nodes { body createdAt } } } } }`,
      { filter: { project: { name: { eq: this.project } }, state: { name: { eq: stateName } } } }
    );
    return data.issues.nodes.map((i) => ({
      id: i.identifier,
      comments: i.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }));
  }

  /** Komentarze issue rosnąco po dacie — do nasłuchiwania decyzji człowieka. */
  async listComments(id: string): Promise<{ body: string; createdAt: string }[]> {
    const data = await this.gql<{ issue: { comments: { nodes: { body: string; createdAt: string }[] } } }>(
      `query($id: String!) { issue(id: $id) { comments { nodes { body createdAt } } } }`,
      { id }
    );
    return data.issue.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async comment(id: string, body: string): Promise<void> {
    const issue = await this.fetchIssue(id);
    await this.gql(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId: issue.id, body } }
    );
  }

  /** Przywraca label-trigger (auto-retry porażek infrastrukturalnych). */
  async relabelReady(id: string): Promise<void> {
    const label = await this.gql<{ issueLabels: { nodes: { id: string }[] } }>(
      `query { issueLabels(filter: { name: { eq: "${READY_LABEL}" } }, first: 1) { nodes { id } } }`
    );
    const labelId = label.issueLabels.nodes[0]?.id;
    if (!labelId) throw new Error(`Brak labela ${READY_LABEL} w workspace`);
    const issue = await this.fetchIssue(id);
    const labelIds = [...new Set([...issue.labels.nodes.map((l) => l.id), labelId])];
    await this.gql(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issue.id, input: { labelIds } }
    );
  }

  /** Upload pliku do CDN Lineara; zwrócony assetUrl można osadzić w markdownie komentarza. */
  async uploadFile(filename: string, contentType: string, data: Buffer): Promise<string> {
    const res = await this.gql<{
      fileUpload: {
        success: boolean;
        uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] };
      };
    }>(
      `mutation($contentType: String!, $filename: String!, $size: Int!) {
        fileUpload(contentType: $contentType, filename: $filename, size: $size) {
          success uploadFile { uploadUrl assetUrl headers { key value } }
        }
      }`,
      { contentType, filename, size: data.byteLength }
    );
    const { uploadUrl, assetUrl, headers } = res.fileUpload.uploadFile;
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000",
        ...Object.fromEntries(headers.map((h) => [h.key, h.value])),
      },
      body: new Uint8Array(data),
    });
    if (!put.ok) throw new Error(`Upload do Lineara nieudany: HTTP ${put.status}`);
    return assetUrl;
  }
}

function pickState(
  states: { id: string; name: string; type: string }[],
  type: string,
  preferredName?: string
): { id: string; name: string } {
  const byName = preferredName && states.find((s) => s.name === preferredName);
  const byType = states.find((s) => s.type === type);
  const state = byName || byType;
  if (!state) throw new Error(`Brak stanu typu "${type}" w teamie Lineara`);
  return state;
}
