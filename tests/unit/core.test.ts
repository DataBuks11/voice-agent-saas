import { describe, it, expect } from "vitest";
import { chunkText, normalizeText, parseOkfMarkdown } from "@voice-agent/rag";
import { buildContext } from "@voice-agent/context";
import { ruleFallback } from "@voice-agent/decision";
import { validateResponse } from "@voice-agent/harness";
import { InMemoryVectorStore } from "@voice-agent/retrieval";
import { HashEmbeddingsProvider } from "@voice-agent/rag";

const WS = "00000000-0000-0000-0000-000000000001";

describe("rag chunking", () => {
  it("chunks with overlap and counts tokens", () => {
    const text = "a".repeat(2000);
    const chunks = chunkText(text, { chunkSize: 800, overlap: 120 }, {}, { workspaceId: WS, documentId: "d1" });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].tokens).toBeGreaterThan(0);
  });
  it("parses OKF frontmatter", () => {
    const { metadata, body } = parseOkfMarkdown("---\nlang: en\ncount: 3\n---\nHello");
    expect(metadata.lang).toBe("en");
    expect(body).toContain("Hello");
  });
  it("normalizes text", () => {
    expect(normalizeText("a\r\n\r\n\r\nb")).toBe("a\n\nb");
  });
});

describe("retrieval + rerank", () => {
  it("isolates tenants", async () => {
    const emb = new HashEmbeddingsProvider(16);
    const [v] = await emb.embed(["hello world"]);
    const store = new InMemoryVectorStore([
      { id: "1", workspaceId: WS, documentId: "d", content: "hello world", tokens: 2, metadata: {}, embedding: v },
      { id: "2", workspaceId: "other", documentId: "d", content: "hello world", tokens: 2, metadata: {}, embedding: v },
    ]);
    const res = await store.search(WS, v, 5);
    expect(res.map((r) => r.workspaceId)).toEqual([WS]);
  });
});

describe("decision + harness", () => {
  it("routes booking text to tools when available", async () => {
    const d = ruleFallback("I want to book an appointment", true, ["book_appointment"]);
    expect(d.route).toBe("use_tools");
  });
  it("falls back on ungrounded answer", () => {
    const v = validateResponse("The moon is made of cheese.", [{ id: "c1", workspaceId: WS, documentId: "d", content: "Our hours are 9-5.", tokens: 5, metadata: {}, score: 0.9 }]);
    expect(v.ok).toBe(false);
    expect(v.safeText).toContain("verified");
  });
  it("builds token-bounded context", () => {
    const ctx = buildContext({
      agent: { id: "a", workspaceId: WS, name: "A", language: "en", tone: "pro", systemPrompt: "sys", fallbackResponse: "fb", maxTokens: 100, temperature: 0, createdAt: "", updatedAt: "" },
      businessProfile: { name: "Demo" },
      history: [{ id: "m", conversationId: "c", role: "user", content: "hi", createdAt: "" }],
      retrieved: [],
      customerMemory: [],
      maxTokens: 200,
    });
    expect(ctx.usedTokens).toBeLessThanOrEqual(200);
  });
});
