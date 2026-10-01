import type { Agent, ConversationMessage, RetrievalResult } from "@voice-agent/types";
import { estimateTokens } from "@voice-agent/shared";

export interface ContextInput {
  agent: Agent;
  businessProfile: Record<string, string>;
  history: ConversationMessage[];
  retrieved: RetrievalResult[];
  customerMemory: string[];
  maxTokens?: number;
}

export interface BuiltContext {
  systemPrompt: string;
  contextText: string;
  usedTokens: number;
  includedChunkIds: string[];
  truncated: boolean;
}

/** Token-aware context builder. Priority: system > business > memory > retrieved > history. */
export function buildContext(input: ContextInput): BuiltContext {
  const max = input.maxTokens ?? 6000;
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  const push = (text: string): boolean => {
    const t = estimateTokens(text);
    if (used + t > max) { truncated = true; return false; }
    parts.push(text);
    used += t;
    return true;
  };

  const systemPrompt = `You are ${input.agent.name}. Language: ${input.agent.language}. Tone: ${input.agent.tone}.\n${input.agent.systemPrompt}`;
  push(`# Agent\n${systemPrompt}`);

  const biz = Object.entries(input.businessProfile).map(([k, v]) => `${k}: ${v}`).join("\n");
  if (biz) push(`# Business\n${biz}`);

  if (input.customerMemory.length) push(`# Customer memory\n- ${input.customerMemory.join("\n- ")}`);

  const includedChunkIds: string[] = [];
  for (const r of input.retrieved) {
    const block = `# Knowledge [${r.id} score=${r.score.toFixed(3)}]\n${r.content}`;
    if (!push(block)) break;
    includedChunkIds.push(r.id);
  }

  // Most recent history first within remaining budget (then restore order).
  const histBlocks: string[] = [];
  for (let i = input.history.length - 1; i >= 0; i--) {
    const m = input.history[i] as ConversationMessage;
    const block = `${m.role}: ${m.content}`;
    const t = estimateTokens(block);
    if (used + t > max) { truncated = true; break; }
    histBlocks.unshift(block);
    used += t;
  }
  if (histBlocks.length) parts.push(`# Conversation\n${histBlocks.join("\n")}`);

  return { systemPrompt, contextText: parts.join("\n\n"), usedTokens: used, includedChunkIds, truncated };
}
