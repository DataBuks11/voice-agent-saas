// Shared domain types. Generic — no business/industry hardcoded.
export type ID = string;
export type ISODate = string;

export interface Workspace { id: ID; name: string; createdAt: ISODate; }
export interface Membership {
  workspaceId: ID; userId: ID; role: "owner" | "admin" | "member";
}

export interface AgentConfig {
  name: string;
  language: string; // BCP-47, e.g. "en-IN"
  tone: string;
  systemPrompt: string;
  fallbackResponse: string;
  maxTokens: number;
  temperature: number;
}

export interface Agent extends AgentConfig {
  id: ID; workspaceId: ID; createdAt: ISODate; updatedAt: ISODate;
}

export interface KnowledgeSource {
  id: ID; workspaceId: ID; agentId: ID | null;
  kind: "upload" | "text" | "url";
  status: "pending" | "processing" | "ready" | "failed";
  createdAt: ISODate;
}

export interface DocumentChunk {
  id: ID; workspaceId: ID; documentId: ID;
  content: string; tokens: number;
  metadata: Record<string, string | number | boolean>;
  embedding?: number[];
  score?: number;
}

export interface ConversationMessage {
  id: ID; conversationId: ID; role: "user" | "assistant" | "system" | "tool";
  content: string; citations?: string[]; createdAt: ISODate;
}

export interface RetrievalResult extends DocumentChunk { score: number; }

export type DecisionRoute =
  | "answer_from_knowledge"
  | "use_tools"
  | "web_search"
  | "small_talk"
  | "escalate";

export interface Decision {
  route: DecisionRoute;
  confidence: number; // 0..1
  reason: string;
  requiredTools?: string[];
}

export interface HarnessVerdict {
  ok: boolean;
  confidence: number;
  issues: string[];
  safeText: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresPermission?: string;
}
