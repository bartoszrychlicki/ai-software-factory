export type FactoryStatus =
  | "in_progress"
  | "needs_clarification"
  | "blocked"
  | "human_review"
  | "done";

export interface Ticket {
  id: string;          // np. LIN-123
  source: string;      // linear | br-crm
  title: string;
  description: string;
  labels: string[];
  priority?: string;
  url?: string;
}

/** Fabryka nie wie, czy gada z Linearem czy br-crm. */
export interface TicketSource {
  name: string;
  listReady(): Promise<Ticket[]>;
  claim(id: string): Promise<void>;
  setStatus(id: string, status: FactoryStatus): Promise<void>;
  comment(id: string, body: string): Promise<void>;
}