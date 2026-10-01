import type { HarnessVerdict, RetrievalResult } from "@voice-agent/types";

export interface HarnessOptions {
  minConfidence?: number;
  fallbackResponse?: string;
  blockedPatterns?: RegExp[];
}

const DEFAULT_BLOCKED = [/ssn|credit card|password/i];

/** Response harness: grounding + policy + fallback. Real checks, no LLM needed. */
export function validateResponse(
  answer: string,
  sources: RetrievalResult[],
  opts: HarnessOptions = {},
): HarnessVerdict {
  const issues: string[] = [];
  const blocked = opts.blockedPatterns ?? DEFAULT_BLOCKED;
  for (const re of blocked) {
    if (re.test(answer)) issues.push(`policy: matched ${re}`);
  }

  // Grounding: every sentence with a factual claim should overlap at least one source.
  const sentences = answer.split(/(?<=[.!?])\s+/).filter(Boolean);
  const sourceText = sources.map((s) => s.content.toLowerCase()).join("\n");
  let grounded = 0;
  for (const s of sentences) {
    const words = s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    if (!words.length) { grounded++; continue; }
    const hits = words.filter((w) => sourceText.includes(w)).length;
    if (hits / words.length >= 0.3) grounded++;
    else issues.push(`ungrounded: "${s.slice(0, 80)}"`);
  }
  const confidence = sentences.length ? grounded / sentences.length : 0;
  const min = opts.minConfidence ?? 0.4;
  const ok = issues.filter((i) => i.startsWith("policy")).length === 0 && confidence >= min;
  return {
    ok,
    confidence,
    issues,
    safeText: ok ? answer : (opts.fallbackResponse ?? "I don't have verified information about that yet. Let me connect you to the team."),
  };
}

/** Unsupported-claim detector: returns sentences with low source overlap. */
export function findUnsupportedClaims(answer: string, sources: RetrievalResult[]): string[] {
  return validateResponse(answer, sources, { minConfidence: 0 }).issues.filter((i) => i.startsWith("ungrounded"));
}
