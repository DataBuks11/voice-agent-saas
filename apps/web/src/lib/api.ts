import { getWorkspace, getToken, type AuthUser } from "./session";

const BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:3001").replace(/\/$/, "");

export interface AgentRow {
  id: string;
  name: string;
  language: string;
  tone: string;
  systemPrompt: string;
  fallbackResponse: string;
  createdAt: string;
}

export interface DocumentRow {
  id: string;
  title: string;
  chunkCount: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface SearchHit {
  id: string;
  document_id: string;
  content: string;
  score: number;
}

export interface ConversationRow {
  id: string;
  channel: string;
  createdAt: string;
}

export interface MessageRow {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  citations: string[];
  createdAt: string;
}

export interface TurnTrace {
  conversationId: string;
  decision: { route: string; confidence: number; reason: string };
  verdict: { ok: boolean; confidence: number; issues: string[] };
  answer: MessageRow;
  userMessage: MessageRow;
  answerSource: string;
  retrieved: { id: string; documentId: string; score: number; text: string }[];
  context: { usedTokens: number; truncated: boolean; includedChunkIds: string[] };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const ws = getWorkspace();
  const token = getToken();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(ws ? { "x-workspace-id": ws.id } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const msg =
      (data as { error?: string } | null)?.error ?? `request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });
const get = <T>(path: string): Promise<T> => request<T>(path);

export const api = {
  base: BASE,
  health: () => get<{ ok: boolean; service: string; ts: string }>("/health"),
  register: (email: string, password: string, name?: string) =>
    post<{ token: string; user: AuthUser }>("/v1/auth/register", { email, password, ...(name ? { name } : {}) }),
  login: (email: string, password: string) =>
    post<{ token: string; user: AuthUser }>("/v1/auth/login", { email, password }),
  me: () => get<{ user: AuthUser }>("/v1/auth/me"),
  createWorkspace: (name: string) =>
    post<{ id: string; name: string; createdAt: string; role: string }>("/v1/workspaces", { name }),
  listWorkspaces: () => get<{ items: WorkspaceLite[]; total: number }>(`/v1/workspaces`),
  listAgents: () => get<{ items: AgentRow[]; total: number }>("/v1/agents?workspaceId=" + getWorkspace()!.id),
  createAgent: (body: { name: string; language: string; tone: string; systemPrompt: string; fallbackResponse: string }) =>
    post<AgentRow>("/v1/agents", { workspaceId: getWorkspace()!.id, ...body }),
  ingest: (title: string, markdown: string) =>
    post<{ sourceId: string; documentId: string; title: string; chunkCount: number; embeddingProvider: string; preview: { tokens: number; text: string }[] }>(
      "/v1/knowledge/ingest",
      { workspaceId: getWorkspace()!.id, title, markdown },
    ),
  documents: () => get<{ items: DocumentRow[]; total: number }>("/v1/knowledge/documents?workspaceId=" + getWorkspace()!.id),
  search: (query: string, topK = 6) =>
    post<{ items: SearchHit[]; total: number }>("/v1/knowledge/search", { workspaceId: getWorkspace()!.id, query, topK }),
  listConversations: () => get<{ items: ConversationRow[]; total: number }>("/v1/conversations?workspaceId=" + getWorkspace()!.id),
  createConversation: (agentId?: string) =>
    post<ConversationRow>("/v1/conversations", { workspaceId: getWorkspace()!.id, ...(agentId ? { agentId } : {}) }),
  messages: (conversationId: string) =>
    get<{ items: MessageRow[]; total: number }>(`/v1/conversations/${conversationId}/messages?workspaceId=${getWorkspace()!.id}`),
  send: (conversationId: string, content: string) =>
    post<TurnTrace>(`/v1/conversations/${conversationId}/messages`, { workspaceId: getWorkspace()!.id, content }),
};

export interface WorkspaceLite {
  id: string;
  name: string;
  role: string;
  createdAt: string;
}
