import type { ConversationMessage } from "@voice-agent/types";

export interface MemoryStore {
  appendTurn(conversationId: string, msg: ConversationMessage, keepLast: number): Promise<ConversationMessage[]>;
  getHistory(conversationId: string): Promise<ConversationMessage[]>;
  rememberCustomer(customerId: string, fact: string): Promise<void>;
  recallCustomer(customerId: string, limit?: number): Promise<string[]>;
}

/** In-memory store for tests/dev; Postgres impl lives in API layer with same interface. */
export class InMemoryMemoryStore implements MemoryStore {
  private turns = new Map<string, ConversationMessage[]>();
  private facts = new Map<string, { fact: string; ts: number }[]>();
  constructor(private retentionDays = 180) {}
  async appendTurn(id: string, msg: ConversationMessage, keepLast: number): Promise<ConversationMessage[]> {
    const arr = [...(this.turns.get(id) ?? []), msg].slice(-keepLast);
    this.turns.set(id, arr);
    return arr;
  }
  async getHistory(id: string): Promise<ConversationMessage[]> {
    return this.turns.get(id) ?? [];
  }
  async rememberCustomer(customerId: string, fact: string): Promise<void> {
    const arr = this.facts.get(customerId) ?? [];
    arr.push({ fact, ts: Date.now() });
    this.facts.set(customerId, arr);
  }
  async recallCustomer(customerId: string, limit = 10): Promise<string[]> {
    const cutoff = Date.now() - this.retentionDays * 86400_000;
    return (this.facts.get(customerId) ?? [])
      .filter((f) => f.ts >= cutoff)
      .slice(-limit)
      .map((f) => f.fact);
  }
}
