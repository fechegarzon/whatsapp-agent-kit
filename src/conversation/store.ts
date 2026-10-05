export interface Turn {
  role: "user" | "agent";
  text: string;
  at: number;
}

export interface Conversation {
  waId: string;
  contactName?: string;
  turns: Turn[];
}

export interface ConversationStore {
  get(waId: string): Promise<Conversation>;
  append(waId: string, turn: Turn, contactName?: string): Promise<Conversation>;
}

/** Keeps the last N turns per contact. Enough for a demo; use a database in production. */
export class MemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  constructor(private readonly maxTurns = 20) {}

  async get(waId: string): Promise<Conversation> {
    const c = this.conversations.get(waId);
    return c ? structuredClone(c) : { waId, turns: [] };
  }

  async append(waId: string, turn: Turn, contactName?: string): Promise<Conversation> {
    const c = this.conversations.get(waId) ?? { waId, turns: [] };
    if (contactName) c.contactName = contactName;
    c.turns.push(turn);
    if (c.turns.length > this.maxTurns) c.turns.splice(0, c.turns.length - this.maxTurns);
    this.conversations.set(waId, c);
    return structuredClone(c);
  }
}
