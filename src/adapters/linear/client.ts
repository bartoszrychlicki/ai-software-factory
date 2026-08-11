import type { FactoryStatus, Ticket, TicketSource } from "../../lifecycle/ticket-source";
import { LINEAR_STATE_MAP } from "../../lifecycle/state-map";
import {
  POLLER_SIGNATURE,
  signatureFooter,
  signatureHeader,
  type ActionSignature,
} from "../../lifecycle/signature";

const API = "https://api.linear.app/graphql";

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
  project: { id: string; name: string } | null;
  state: { id: string; name: string; type: string };
  team: { states: { nodes: { id: string; name: string; type: string }[] } };
}

export interface LinearIssueReference {
  id: string;
  projectName: string | null;
}

interface LinearProjectForCreate {
  id: string;
  name: string;
  teams: {
    nodes: {
      id: string;
      name: string;
      states: { nodes: { id: string; name: string; type: string }[] };
      labels: { nodes: { id: string; name: string }[] };
    }[];
  };
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
}

export interface LinearCommandCandidate {
  id: string;
  stateName: string;
  stateType: string;
  comments: LinearComment[];
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

  private assertMutationSuccess(
    payload: { success?: boolean } | null | undefined,
    what: string
  ): void {
    if (!payload || payload.success !== true) {
      throw new Error(`Linear nie potwierdził zapisu: ${what}`);
    }
  }

  private issueFields = `
    id identifier title description url priorityLabel
    labels { nodes { id name } }
    project { id name }
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

  async resolveIssue(identifier: string): Promise<LinearIssueReference> {
    const data = await this.gql<{
      issue: { id: string; project: { name: string } | null };
    }>(
      `query($id: String!) { issue(id: $id) { id project { name } } }`,
      { id: identifier }
    );
    return {
      id: data.issue.id,
      projectName: data.issue.project?.name ?? null,
    };
  }

  async getTicket(identifier: string): Promise<
    Ticket & { stateName: string; stateType: string; projectName: string | null }
  > {
    const issue = await this.fetchIssue(identifier);
    return {
      id: issue.identifier,
      source: this.name,
      title: issue.title,
      description: issue.description ?? "",
      labels: issue.labels.nodes.map((label) => label.name),
      priority: issue.priorityLabel ?? undefined,
      url: issue.url,
      stateName: issue.state.name,
      stateType: issue.state.type,
      projectName: issue.project?.name ?? null,
    };
  }

  /** Zakłada ręcznie zlecony ticket zawsze w backlogu projektu, nigdy w kolejce pollera. */
  async createIssue(input: {
    title: string;
    description?: string;
    labels?: string[];
  }): Promise<{ identifier: string; url: string }> {
    const data = await this.gql<{ projects: { nodes: LinearProjectForCreate[] } }>(
      `query($name: String!) {
        projects(filter: { name: { eq: $name } }, first: 2) {
          nodes {
            id name
            teams {
              nodes {
                id name
                states { nodes { id name type } }
                labels { nodes { id name } }
              }
            }
          }
        }
      }`,
      { name: this.project }
    );
    if (data.projects.nodes.length !== 1) {
      throw new Error(
        data.projects.nodes.length === 0
          ? `Brak projektu "${this.project}" w Linearze`
          : `Nazwa projektu "${this.project}" nie jest jednoznaczna w Linearze`
      );
    }
    const project = data.projects.nodes[0];
    if (project.teams.nodes.length !== 1) {
      throw new Error(
        `Projekt "${this.project}" musi należeć do dokładnie jednego teamu, ` +
        `a należy do ${project.teams.nodes.length}`
      );
    }
    const team = project.teams.nodes[0];
    const requestedLabels = [...new Set(input.labels ?? [])];
    const labelsByName = new Map(team.labels.nodes.map((label) => [label.name, label.id]));
    const unknownLabels = requestedLabels.filter((label) => !labelsByName.has(label));
    if (unknownLabels.length) {
      throw new Error(`Nieznane labele w teamie "${team.name}": ${unknownLabels.join(", ")}`);
    }
    const backlog = pickState(team.states.nodes, "backlog");
    const created = await this.gql<{
      issueCreate: { success: boolean; issue: { identifier: string; url: string } | null };
    }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { identifier url } }
      }`,
      {
        input: {
          teamId: team.id,
          projectId: project.id,
          stateId: backlog.id,
          title: input.title,
          description: input.description ?? "",
          labelIds: requestedLabels.map((label) => labelsByName.get(label)),
        },
      }
    );
    if (!created.issueCreate.success || !created.issueCreate.issue) {
      throw new Error(`Linear nie utworzył issue w projekcie "${this.project}"`);
    }
    return created.issueCreate.issue;
  }

  /**
   * Tickety oddane fabryce przez człowieka = stan `ready` z mapy (Linear: "Todo").
   * STAN, nie label — sterowanie przepływem jest deterministyczne i widoczne na tablicy.
   * Label-trigger `agent:ready` wycięty w BAR-147 razem z flagą FACTORY_LABEL_TRIGGER.
   */
  async listReady(): Promise<Ticket[]> {
    const filter = { project: { name: { eq: this.project } }, state: { name: { eq: LINEAR_STATE_MAP.ready } } };
    const data = await this.gql<{ issues: { nodes: LinearIssue[] } }>(
      `query($filter: IssueFilter) { issues(filter: $filter, first: 25) { nodes { ${this.issueFields} } } }`,
      { filter }
    );
    return data.issues.nodes.map((i) => ({
      id: i.identifier,
      source: this.name,
      title: i.title,
      description: i.description ?? "",
      labels: i.labels.nodes.map((l) => l.name),
      priority: i.priorityLabel ?? undefined,
      url: i.url,
    }));
  }

  /**
   * Zabiera ticket z kolejki: przestawia stan na "started", żeby kolejny poll go nie
   * zobaczył. Labeli NIE rusza — są wyłącznie informacyjne (BAR-142/147).
   * Fazę właściwą ustawia poller przez setPhase.
   */
  async claim(id: string, preferredStateName?: string): Promise<void> {
    const issue = await this.fetchIssue(id);
    const preferred = preferredStateName
      ? issue.team.states.nodes.find((state) => state.name === preferredStateName)
      : undefined;
    if (preferredStateName && !preferred) {
      console.warn(
        `[${id}] brak preferowanego stanu claim "${preferredStateName}" — ` +
          "fallback do stanu started."
      );
    }
    const started = preferred ?? pickState(issue.team.states.nodes, "started", "In Progress");
    const result = await this.gql<{ issueUpdate: { success: boolean } | null }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issue.id, input: { stateId: started.id } }
    );
    this.assertMutationSuccess(result?.issueUpdate, `claim ticketu ${id}`);
  }

  async setStatus(id: string, status: FactoryStatus): Promise<void> {
    const issue = await this.fetchIssue(id);
    const preferredName = status === "human_review"
      ? "In Review"
      : status === "in_progress"
        ? "In Progress"
        : status === "needs_clarification"
          ? LINEAR_STATE_MAP.ready
          : status === "blocked"
            ? "👤 ⛔ Zablokowany"
            : undefined;
    const state = pickState(issue.team.states.nodes, STATUS_TO_STATE_TYPE[status], preferredName);
    const result = await this.gql<{ issueUpdate: { success: boolean } | null }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issue.id, input: { stateId: state.id } }
    );
    this.assertMutationSuccess(result?.issueUpdate, `zmiana statusu ticketu ${id} na ${status}`);
  }

  /** Issues projektu w danym stanie, z komentarzami — dla merge-watchera i adopcji sierot. */
  async listWithComments(
    stateName: string
  ): Promise<{ id: string; comments: LinearComment[] }[]> {
    const data = await this.gql<{
      issues: { nodes: { identifier: string; comments: { nodes: LinearComment[] } }[] };
    }>(
      `query($filter: IssueFilter) { issues(filter: $filter, first: 50) {
        nodes { identifier comments { nodes { id body createdAt } } } } }`,
      { filter: { project: { name: { eq: this.project } }, state: { name: { eq: stateName } } } }
    );
    return data.issues.nodes.map((i) => ({
      id: i.identifier,
      comments: i.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }));
  }

  /** Nieterminalne tickety projektu z komentarzami — globalne komendy operatorskie. */
  async listCommandCandidates(): Promise<LinearCommandCandidate[]> {
    const data = await this.gql<{
      issues: {
        nodes: {
          identifier: string;
          state: { name: string; type: string };
          comments: { nodes: LinearComment[] };
        }[];
      };
    }>(
      `query($filter: IssueFilter) { issues(filter: $filter, first: 100) {
        nodes { identifier state { name type } comments { nodes { id body createdAt } } }
      } }`,
      { filter: { project: { name: { eq: this.project } } } }
    );
    return data.issues.nodes
      .filter((issue) => !LINEAR_STATE_MAP.terminal.includes(issue.state.name))
      .map((issue) => ({
        id: issue.identifier,
        stateName: issue.state.name,
        stateType: issue.state.type,
        comments: issue.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      }));
  }

  /** Komentarze issue rosnąco po dacie — do nasłuchiwania decyzji człowieka. */
  async listComments(id: string): Promise<LinearComment[]> {
    const data = await this.gql<{ issue: { comments: { nodes: LinearComment[] } } }>(
      `query($id: String!) { issue(id: $id) { comments { nodes { id body createdAt } } } }`,
      { id }
    );
    return data.issue.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async comment(
    id: string,
    body: string,
    signature: ActionSignature = POLLER_SIGNATURE
  ): Promise<void> {
    const issue = await this.fetchIssue(id);
    await this.commentByIssueId(issue.id, body, signature);
  }

  async commentByIssueId(
    issueId: string,
    body: string,
    signature: ActionSignature = POLLER_SIGNATURE
  ): Promise<void> {
    const signedBody = signature.profile === "orchestrator"
      ? body
      : `${signatureHeader(signature)}\n\n${body}`;
    const result = await this.gql<{ commentCreate: { success: boolean } | null }>(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId, body: signedBody + signatureFooter(signature) } }
    );
    this.assertMutationSuccess(result?.commentCreate, `komentarz do issue ${issueId}`);
  }

  /** Ustawia stan po dokładnej nazwie (stany procesu fabryki). */
  async setStateByName(id: string, stateName: string): Promise<void> {
    const issue = await this.fetchIssue(id);
    const state = issue.team.states.nodes.find((s) => s.name === stateName);
    if (!state) throw new Error(`Brak stanu "${stateName}" w teamie`);
    const result = await this.gql<{ issueUpdate: { success: boolean } | null }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issue.id, input: { stateId: state.id } }
    );
    this.assertMutationSuccess(result?.issueUpdate, `zmiana stanu ticketu ${id} na "${stateName}"`);
  }

  /** Aktualna nazwa stanu issue (wykrywanie aprobaty przez przeciągnięcie karty). */
  async getStateName(id: string): Promise<string> {
    const issue = await this.fetchIssue(id);
    return issue.state.name;
  }

  /** Nazwy stanów teamu obsługującego projekt — health-check mapy procesu przy starcie pollera. */
  async listStateNames(): Promise<string[]> {
    const data = await this.gql<{
      issues: { nodes: { team: { states: { nodes: { name: string }[] } } }[] };
    }>(
      `query($filter: IssueFilter) { issues(filter: $filter, first: 1) {
        nodes { team { states { nodes { name } } } }
      } }`,
      { filter: { project: { name: { eq: this.project } } } }
    );
    const states = data.issues.nodes[0]?.team.states.nodes;
    if (!states) throw new Error(`Projekt "${this.project}" nie ma issue, z którego można odczytać stany teamu`);
    return states.map((state) => state.name);
  }

  /** Ile ticketów projektu jest w toku (stany typu started: In Progress/In Review + stany procesu). */
  async countActive(): Promise<number> {
    const data = await this.gql<{ issues: { nodes: { id: string }[] } }>(
      `query($filter: IssueFilter) { issues(filter: $filter, first: 50) { nodes { id } } }`,
      { filter: { project: { name: { eq: this.project } }, state: { type: { eq: "started" } } } }
    );
    return data.issues.nodes.length;
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

export function pickState(
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
