/** Latency probe: same question, streamed vs plain, repeated in one conversation. */
const API = process.env.API_BASE_URL ?? "https://voice-agent-saas-production-3001.up.railway.app";
const Q = process.argv[2] ?? "How much does a standard haircut cost?";
const DOC = `# Pricing\nA standard haircut is 400 INR. Premium styling is 900 INR.\n\n# Hours\nWe are open Monday to Saturday, 10am to 8pm. Sunday closed.`;

const call = async (path, { method = "GET", token, body, headers = {} } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};

const main = async () => {
  const email = `lat-${Math.random().toString(36).slice(2, 10)}@voiceagent.dev`;
  const reg = await call("/v1/auth/register", { method: "POST", body: { email, password: "Passw0rd!2026" } });
  const token = reg.token;
  const ws = (await call("/v1/workspaces", { method: "POST", token, body: { name: "Latency" } })).id;
  const headers = { "x-workspace-id": ws };
  await call("/v1/knowledge/ingest", { method: "POST", token, headers, body: { workspaceId: ws, title: "Pricing", markdown: DOC } });
  const conv = (await call("/v1/conversations", { method: "POST", token, headers, body: { workspaceId: ws, channel: "voice" } })).id;

  const plain = async () => {
    const t0 = Date.now();
    const r = await call(`/v1/conversations/${conv}/messages`, { method: "POST", token, headers, body: { workspaceId: ws, content: Q } });
    return { ms: Date.now() - t0, source: r.answerSource };
  };
  const streamed = async () => {
    const t0 = Date.now();
    let first = 0;
    const res = await fetch(`${API}/v1/conversations/${conv}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ workspaceId: ws, content: Q }),
    });
    if (!res.ok || !res.body) return { ms: -1, first: -1, note: `stream -> ${res.status}` };
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!first) first = Date.now() - t0;
    }
    return { ms: Date.now() - t0, first };
  };

  const rows = [];
  for (let i = 0; i < 3; i++) {
    rows.push({ run: i + 1, plain: await plain(), stream: await streamed() });
  }
  for (const r of rows) {
    console.log(
      `run ${r.run}: plain ${r.plain.ms}ms (${r.plain.source}) | stream first ${r.stream.first}ms total ${r.stream.ms}ms`,
    );
  }
};
main().catch((e) => {
  console.error("LATENCY PROBE ERROR", e.message);
  process.exit(1);
});