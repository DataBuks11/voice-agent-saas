import type { Decision, DecisionRoute } from "@voice-agent/types";

export interface DecisionProvider {
  name: string;
  decide(input: { text: string; hasKnowledge: boolean; toolsAvailable: string[] }): Promise<Decision>;
}

/**
 * Laya-compatible routing abstraction: any classifier (local model / remote API)
 * can implement this interface. Rules fallback always exists.
 */
export interface LayaCompatibleClassifier {
  classify(text: string): Promise<{ label: string; confidence: number }>;
}

/** Deterministic rules fallback — cheap, no LLM call. */
export function ruleFallback(text: string, hasKnowledge: boolean, toolsAvailable: string[]): Decision {
  const t = text.toLowerCase();
  const hasTool = (name: string) => toolsAvailable.includes(name);
  if (
    hasTool("book_appointment") &&
    /\b(book|booking|booked|appointment|schedule|slot|reserve|reservation)\b/.test(t)
  ) {
    return { route: "use_tools", confidence: 0.75, reason: "booking intent + calendar tool", requiredTools: ["book_appointment"] };
  }
  if (
    hasTool("get_location") &&
    /\b(where are you|address|location|located|directions|map|reach you|find you|reach the|come to)\b/.test(t)
  ) {
    return { route: "use_tools", confidence: 0.7, reason: "location intent + maps tool", requiredTools: ["get_location"] };
  }
  if (/\b(latest|today|news|price now|weather|search|web)\b/.test(t)) {
    return { route: "web_search", confidence: 0.65, reason: "freshness/external info requested" };
  }
  if (/\b(hi|hello|thanks|bye|hey)\b/.test(t) && text.length < 30) {
    return { route: "small_talk", confidence: 0.8, reason: "greeting pattern" };
  }
  if (hasKnowledge) {
    return { route: "answer_from_knowledge", confidence: 0.6, reason: "knowledge available, default to grounding" };
  }
  return { route: "escalate", confidence: 0.5, reason: "no knowledge, no clear tool — escalate" };
}

export class RuleDecisionProvider implements DecisionProvider {
  name = "rules-fallback";
  async decide(input: { text: string; hasKnowledge: boolean; toolsAvailable: string[] }): Promise<Decision> {
    return ruleFallback(input.text, input.hasKnowledge, input.toolsAvailable);
  }
}

export function toRoute(label: string): DecisionRoute {
  const l = label.toLowerCase();
  if (l.includes("tool")) return "use_tools";
  if (l.includes("search") || l.includes("web")) return "web_search";
  if (l.includes("small") || l.includes("greet")) return "small_talk";
  if (l.includes("escal")) return "escalate";
  return "answer_from_knowledge";
}
