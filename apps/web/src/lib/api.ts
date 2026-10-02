import { getWorkspace, getToken, type AuthUser } from "./session";

const BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:3001").replace(/\/$/, "");

export interface AgentRow {
  id: string;
  name: string;
  language: string;
  tone: string;
  systemPrompt: string;
  fallbackResponse: string;
  location?: string;
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

export interface BookingRow {
  id: string;
  conversationId: string | null;
  customerName: string;
  contact: string;
  startsAt: string;
  notes: string;
  status: string;
  source: string;
  createdAt: string;
}

export interface ToolResultRow {
  type: "calendar" | "maps";
  label: string;
  url: string;
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
  toolResults?: ToolResultRow[];
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
  createAgent: (body: { name: string; language: string; tone: string; systemPrompt: string; fallbackResponse: string; location?: string }) =>
    post<AgentRow>("/v1/agents", { workspaceId: getWorkspace()!.id, ...body }),
  ingest: (title: string, markdown: string, opts?: { documentId?: string }) =>
    post<{ sourceId: string | null; documentId: string; title: string; chunkCount: number; embeddingProvider: string; preview: { tokens: number; text: string }[] }>(
      "/v1/knowledge/ingest",
      { workspaceId: getWorkspace()!.id, title, markdown, ...(opts?.documentId ? { documentId: opts.documentId } : {}) },
    ),
  uploadFile: (filename: string, contentBase64: string, title?: string) =>
    post<{ sourceId: string; documentId: string; title: string; chunkCount: number; embeddingProvider: string }>(
      "/v1/knowledge/upload",
      { workspaceId: getWorkspace()!.id, filename, contentBase64, ...(title ? { title } : {}) },
    ),
  bookings: () => get<{ items: BookingRow[]; total: number }>("/v1/bookings?workspaceId=" + getWorkspace()!.id),
  documents: () => get<{ items: DocumentRow[]; total: number }>("/v1/knowledge/documents?workspaceId=" + getWorkspace()!.id),
  search: (query: string, topK = 6) =>
    post<{ items: SearchHit[]; total: number }>("/v1/knowledge/search", { workspaceId: getWorkspace()!.id, query, topK }),
  listConversations: () => get<{ items: ConversationRow[]; total: number }>("/v1/conversations?workspaceId=" + getWorkspace()!.id),
  createConversation: (agentId?: string) =>
    post<ConversationRow>("/v1/conversations", { workspaceId: getWorkspace()!.id, channel: "web", ...(agentId ? { agentId } : {}) }),
  messages: (conversationId: string) =>
    get<{ items: MessageRow[]; total: number }>(`/v1/conversations/${conversationId}/messages?workspaceId=${getWorkspace()!.id}`),
  send: (conversationId: string, content: string) =>
    post<TurnTrace>(`/v1/conversations/${conversationId}/messages`, { workspaceId: getWorkspace()!.id, content }),
  /**
   * Streaming turn: SSE deltas stream in as `partial` (live typing preview),
   * resolves with the full TurnTrace on the final event (harness verdict may
   * have replaced the preview). Fast paths reply with plain JSON — handled here.
   */
  sendStream: async (conversationId: string, content: string, onDelta: (partial: string) => void): Promise<TurnTrace> => {
    const ws = getWorkspace();
    const token = getToken();
    const res = await fetch(`${BASE}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(ws ? { "x-workspace-id": ws.id } : {}),
      },
      body: JSON.stringify({ workspaceId: ws!.id, content, stream: true }),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { error: text };
      }
      if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? `request failed (${res.status})`, res.status);
      return data as TurnTrace;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let final: TurnTrace | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const j = JSON.parse(line.slice(5).trim()) as { type?: string; text?: string; message?: string } & TurnTrace;
          if (j.type === "delta") onDelta(String(j.text ?? ""));
          else if (j.type === "final") final = j;
          else if (j.type === "error") throw new ApiError(String(j.message ?? "stream failed"), 500);
        } catch (err) {
          if (err instanceof ApiError) throw err;
          // unparsable frame — skip
        }
      }
    }
    if (!final) throw new ApiError("stream ended without a final answer", 502);
    return final;
  },
};

export interface WorkspaceLite {
  id: string;
  name: string;
  role: string;
  createdAt: string;
}
