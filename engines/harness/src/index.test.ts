import { describe, expect, it } from "vitest";
import { isConversational, validateResponse } from "./index.js";

const sources = [
  { id: "1", workspaceId: "w", documentId: "d", content: "A standard haircut is 400 INR.", tokens: 0, metadata: {}, score: 0.5 },
] as never;

describe("conversational replies", () => {
  it("are not scored as ungrounded", () => {
    const v = validateResponse("Thank you. Please let me know if you have any other questions.", sources);
    expect(v.ok).toBe(true);
    expect(v.confidence).toBe(1);
    expect(v.safeText).toContain("Thank you");
  });

  it("recognises greetings and acknowledgements", () => {
    for (const s of [
      "Hello, how may I help you today?",
      "Sure, one moment.",
      "Got it.",
      "No problem.",
      "Of course, happy to help.",
    ]) {
      expect(isConversational(s), s).toBe(true);
    }
  });

  it("still checks sentences that make claims", () => {
    for (const s of [
      "A standard haircut is 400 INR.",
      "We are open Monday to Saturday, 10am to 8pm.",
      "The price is 900 rupees for premium styling.",
    ]) {
      expect(isConversational(s), s).toBe(false);
    }
  });

  it("does not excuse a hallucinated business fact", () => {
    const v = validateResponse("Our address is 14B Baker Street and we open at 3am daily.", sources);
    expect(v.ok).toBe(false);
    expect(v.safeText).not.toContain("Baker Street");
  });

  it("still flags a bad claim that follows a greeting", () => {
    const v = validateResponse("Sure. Our address is 14B Baker Street.", sources);
    expect(v.issues.some((i) => i.startsWith("ungrounded"))).toBe(true);
  });

  it("mixes a greeting with a supported fact", () => {
    const v = validateResponse("Thanks for asking. A standard haircut is 400 INR.", sources);
    expect(v.ok).toBe(true);
  });
});