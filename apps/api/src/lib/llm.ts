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
 *   (works with OpenAI, Gemini OpenAI-compat endpoint, Token Harbor, etc.)
 * - otherwise / on provider failure -> grounded extractive answer built from
 *   retrieved context (deterministic, harness-validated, never invents outside sources)
 */
export async function complete(opts: LlmOptions): Promise<LlmResult> {
  const apiKey = process.env.LLM_API_KEY ?? "";
  if (!apiKey) return { text: groundedAnswer(opts), source: "grounded-fallback" };

  const base = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 300);
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 15000);
  const reasoningEffort = process.env.LLM_REASONING_EFFORT ?? "";

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: maxTokens,
        // Gemini: minimal reasoning budget = fastest replies (ignored by providers that don't support it)
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        messages: [
          { role: "system", content: `${opts.system}\n\n${opts.context}` },
          { role: "user", content: opts.user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`llm request failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const text = json.choices[0]?.message.content?.trim();
    if (!text) return { text: groundedAnswer(opts), source: "grounded-fallback" };
    return { text, source: "llm" };
  } catch (err) {
    // Provider down/slow: never fail the turn — degrade to grounded extractive answer.
    console.error(`llm degraded to grounded fallback: ${(err as Error).message}`);
    return { text: groundedAnswer(opts), source: "grounded-fallback" };
  }
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
