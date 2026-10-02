/**
 * Document QA against a deployed API.
 *
 * Uploads a real file, asks the questions a caller actually asks, and fails on
 * the two failure modes that used to ship: a canned refusal when the document
 * clearly answers, and an answer that ignores the document.
 *
 *   node scripts/_doc_qa.mjs "C:\path\to\Unit-4 programm.docx"
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const API = process.env.API_BASE_URL ?? "https://voice-agent-saas-production-3001.up.railway.app";
const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/_doc_qa.mjs <file.docx|.pdf|.md>");
  process.exit(2);
}

// must contain one of these substrings, case-insensitive
// Expectations are per-document; override with DOC_QA_EXPECT=<json file>.
const QUESTIONS = [
  { q: "What are the unit objectives?", expect: ["student information", "marks", "file", "count"] },
  { q: "What is this document about?", expect: ["file", "program", "c "] },
  { q: "Which file operations are covered?", expect: ["read", "writ", "append", "creat"] },
  { q: "What are the topics covered?", expect: [] },
  { q: "How do I count lines in a file?", expect: ["line"] },
  { q: "What is the capital of France?", expect: ["check with the team", "don't have", "not in"], absent: true },
  { q: "What are you doing right now?", expect: [], chitchat: true },
  { q: "Okay, no problem", expect: [], chitchat: true },
];

const REFUSALS = [
  "i don't have verified information",
  "i do not have verified information",
  "not in my notes",
  "i'm not sure",
  "i am not sure",
  "could you rephrase",
  "check with the team",
];

const api = async (path, { method = "GET", token, body, headers = {} } = {}) => {
  const h = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body && !headers["content-type"] && typeof body === "string"
      ? { "content-type": "application/json" }
      : {}),
    ...headers,
  };
  if (body && typeof body !== "string" && !h["content-length"]) {
    h["content-length"] = String(body.byteLength ?? body.length);
  }
  const res = await fetch(`${API}${path}`, { method, headers: h, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};

const main = async () => {
  const email = `docqa-${Math.random().toString(36).slice(2, 10)}@voiceagent.dev`;
  const reg = await api("/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: "Passw0rd!2026", name: "Doc QA" }),
  });
  const token = reg.token;
  const headers = { authorization: `Bearer ${token}` };
  const ws = await api("/v1/workspaces", {
    method: "POST",
    token,
    body: JSON.stringify({ name: "Doc QA" }),
  });
  const wsId = ws.id;
  headers["x-workspace-id"] = wsId;

  const buf = await readFile(file);
  const title = basename(file);
  const up = await api("/v1/knowledge/upload", {
    method: "POST",
    token,
    headers,
    body: JSON.stringify({
      workspaceId: wsId,
      filename: title,
      contentBase64: buf.toString("base64"),
    }),
  });
  console.log(`[upload] ${title} -> ${JSON.stringify(up).slice(0, 200)}`);

  const conv = await api("/v1/conversations", {
    method: "POST",
    token,
    headers,
    body: JSON.stringify({ workspaceId: wsId, channel: "voice" }),
  });
  const convId = conv.id ?? conv.conversationId;

  let failures = 0;
  for (const { q, expect, chitchat, ungrounded, absent } of QUESTIONS) {
    const t0 = Date.now();
    const res = await api(`/v1/conversations/${convId}/messages`, {
      method: "POST",
      token,
      headers,
      body: JSON.stringify({ workspaceId: wsId, content: q }),
    });
    const ms = Date.now() - t0;
    const raw = res.answer ?? res.text ?? "";
    const text = typeof raw === "string" ? raw : (raw.text ?? raw.content ?? JSON.stringify(raw));
    const low = text.toLowerCase();
    const refused = REFUSALS.some((r) => low.includes(r));
    const hit = expect.some((e) => low.includes(e));
    let verdict = "ok";
    if (absent) {
      // A question the document cannot answer must NOT be invented.
      if (!refused) {
        verdict = "HALLUCINATED";
        failures++;
      } else {
        verdict = "declined as expected";
      }
    } else if (refused && !chitchat) {
      verdict = "CANNED REFUSAL";
      failures++;
    } else if (expect.length && !hit) {
      verdict = "MISSING KEYWORDS";
      failures++;
    } else if (ungrounded) {
      verdict = "answered";
    }
    console.log(
      `\nQ: ${q}\n   ${ms}ms source=${res.answerSource ?? res.source ?? "?"} verdict=${JSON.stringify(res.verdict)?.slice(0, 120)} ` +
        `verdict=${res.verdict?.ok === false ? "harness-reject" : "pass"} [${verdict}]\n   A: ${text}`,
    );
  }

  console.log(`\nDOC QA ${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error("DOC QA ERROR", err.message);
  process.exit(1);
});