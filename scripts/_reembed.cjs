// Re-embed every chunk with the configured provider (Gemini when EMBEDDING_* env set).
// Fixes mixed-vector corpora after switching embedding providers.
// Usage: DATABASE_URL=... EMBEDDING_API_KEY=... node scripts/_reembed.cjs
const pg = require("../apps/api/node_modules/pg");

const URL_ = process.env.EMBEDDING_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai";
const KEY = process.env.EMBEDDING_API_KEY;
const MODEL = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
const DIMS = Number(process.env.EMBEDDING_DIMENSIONS || 1536);
const BATCH = 64;

async function embedBatch(texts) {
  const body = JSON.stringify({ model: MODEL, input: texts, dimensions: DIMS });
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${URL_.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body,
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = 1000 * Math.pow(2, attempt);
      console.log(`  rate-limited (${res.status}), retry in ${wait}ms…`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      lastErr = `embeddings failed (${res.status}): ${(await res.text()).slice(0, 300)}`;
      break;
    }
    const json = await res.json();
    return json.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
  if (!lastErr) throw new Error("embeddings: retries exhausted");
  // Isolate the offending text: split the batch until one input is blamed.
  if (texts.length > 1) {
    const mid = Math.ceil(texts.length / 2);
    console.log(`  batch failed, splitting ${texts.length} inputs…`);
    const a = await embedBatch(texts.slice(0, mid));
    const b = await embedBatch(texts.slice(mid));
    return [...a, ...b];
  }
  throw new Error(`${lastErr}\n  offending input: ${JSON.stringify(texts[0].slice(0, 200))}`);
}

(async () => {
  if (!KEY) throw new Error("EMBEDDING_API_KEY required");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const total = await db.query("select count(*)::int as n from chunks");
    console.log(`re-embedding ${total.rows[0].n} chunks with ${MODEL} (${DIMS}d)…`);
    const t0 = Date.now();
    let done = 0;
    // Simple id page loop (corpora are modest; avoids holding one giant result set).
    let lastId = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const page = await db.query("select id, content from chunks where id > $1::uuid order by id limit $2", [lastId, BATCH]);
      if (!page.rows.length) break;
      const ids = page.rows.map((r) => r.id);
      const texts = page.rows.map((r) => r.content);
      const vectors = await embedBatch(texts);
      for (let i = 0; i < ids.length; i++) {
        await db.query("update chunks set embedding = $1::vector where id = $2::uuid", [JSON.stringify(vectors[i]), ids[i]]);
      }
      done += ids.length;
      lastId = ids[ids.length - 1];
      console.log(`  ${done}/${total.rows[0].n}`);
    }
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // Sanity: cosine search should return a plausible top hit.
    const [qv] = await embedBatch(["how much does it cost"]);
    const check = await db.query(
      `select c.document_id, left(c.content, 60) as preview,
              1 - (c.embedding <=> $1::vector) as score
       from chunks c order by c.embedding <=> $1::vector limit 3`,
      [JSON.stringify(qv)],
    );
    console.log("sanity search:", check.rows.map((r) => `${r.score.toFixed(3)} ${r.preview}`).join(" | "));
  } finally {
    await db.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
