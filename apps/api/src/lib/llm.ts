export interface LlmResult {
  text: string;
  source: "llm" | "grounded-fallback";
}

export interface LlmOptions {
  system: string;
  context: string;
  user: string;
  fallback: string;
}

/**
 * LLM step:
 * - LLM_API_KEY set  -> OpenAI-compatible /chat/completions
 * - otherwise        -> grounded extractive answer built from retrieved context
 *   (deterministic, harness-validated, never invents outside sources)
 */
export async function complete(opts: LlmOptions): Promise<LlmResult> {
  const apiKey = process.env.LLM_API_KEY ?? "";
  if (!apiKey) return { text: groundedAnswer(opts), source: "grounded-fallback" };

  const base = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: `${opts.system}\n\n${opts.context}` },
        { role: "user", content: opts.user },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`llm request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  const text = json.choices[0]?.message.content?.trim();
  if (!text) return { text: groundedAnswer(opts), source: "grounded-fallback" };
  return { text, source: "llm" };
}

/** Extract the knowledge block out of the built context and return the most relevant slice. */
function groundedAnswer(opts: LlmOptions): string {
  const blocks = [...opts.context.matchAll(/# Knowledge \[([^\]]+) score=([0-9.]+)\]\n([\s\S]*?)(?=\n# Knowledge \[|\n# Conversation|$)/g)];
  if (!blocks.length) return opts.fallback;
  const best = blocks[0]?.[3]?.trim() ?? "";
  if (!best) return opts.fallback;
  const sentences = best.split(/(?<=[.!?])\s+/).filter(Boolean);
  const answer = sentences.slice(0, 3).join(" ");
  return answer.length ? answer : best.slice(0, 400);
}
