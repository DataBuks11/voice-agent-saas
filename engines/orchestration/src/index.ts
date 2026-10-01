import type { BuiltContext } from "@voice-agent/context";
import type { Decision, HarnessVerdict } from "@voice-agent/types";

// Orchestration defines the pipeline contract; concrete LLM/STT/TTS live behind interfaces
// so voice + text share one path without vendor lock-in.
export interface LlmProvider {
  name: string;
  complete(input: { system: string; context: string; user: string }): Promise<{ text: string }>;
}

export interface OrchestratorDeps {
  decide: (text: string) => Promise<Decision>;
  retrieve: (query: string) => Promise<import("@voice-agent/types").RetrievalResult[]>;
  buildContext: (retrieved: import("@voice-agent/types").RetrievalResult[], history: import("@voice-agent/types").ConversationMessage[]) => Promise<BuiltContext>;
  llm: LlmProvider;
  validate: (answer: string, sources: import("@voice-agent/types").RetrievalResult[]) => Promise<HarnessVerdict>;
}

export async function runTurn(
  deps: OrchestratorDeps,
  userText: string,
  history: import("@voice-agent/types").ConversationMessage[],
): Promise<{ text: string; decision: Decision; verdict: HarnessVerdict }> {
  const decision = await deps.decide(userText);
  let retrieved: import("@voice-agent/types").RetrievalResult[] = [];
  if (decision.route === "answer_from_knowledge" || decision.route === "web_search") {
    retrieved = await deps.retrieve(userText);
  }
  const ctx = await deps.buildContext(retrieved, history);
  const { text } = await deps.llm.complete({ system: ctx.systemPrompt, context: ctx.contextText, user: userText });
  const verdict = await deps.validate(text, retrieved);
  return { text: verdict.safeText, decision, verdict };
}
