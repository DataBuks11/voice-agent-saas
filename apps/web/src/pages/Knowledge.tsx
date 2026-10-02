import React from "react";
import { api, type DocumentRow, type SearchHit } from "../lib/api";
import { useToast } from "../main";

const SAMPLE = `---
title: Acme Pricing FAQ
category: pricing
---

# Pricing
Standard haircut is 400 INR. Premium styling is 900 INR.

# Hours
We are open Monday to Saturday, 10am to 8pm. Sunday closed.

# Cancellation
Free cancellation up to 6 hours before the appointment.`;

export function KnowledgePage() {
  const toast = useToast();
  const [title, setTitle] = React.useState("");
  const [markdown, setMarkdown] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [docs, setDocs] = React.useState<DocumentRow[]>([]);
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<SearchHit[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [fileBusy, setFileBusy] = React.useState(false);
  const [fileProg, setFileProg] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    api
      .documents()
      .then((r) => setDocs(r.items))
      .catch((e) => toast({ kind: "err", text: e.message }));
  }, [toast]);

  React.useEffect(load, [load]);

  const uploadFile = async () => {
    if (!file) return;
    const isDoc = /\.pdf$/i.test(file.name) || /\.docx$/i.test(file.name);
    const isText = /\.(md|markdown|txt|text|csv|tsv|json|log|rst|adoc|html?)$/i.test(file.name) || !file.name.includes(".");
    if (!isDoc && !isText) {
      toast({ kind: "err", text: "Unsupported type — use .md, .txt, .pdf or .docx" });
      return;
    }
    const sizeMB = file.size / 1048576;
    if (isDoc && sizeMB > 20) {
      toast({ kind: "err", text: "PDF/DOCX up to 20MB — convert big files to .txt/.md for unlimited upload" });
      return;
    }
    setFileBusy(true);
    setFileProg("Preparing…");
    try {
      let chunkTotal = 0;
      if (isText) {
        // Chunked upload: stream the file in slices so huge text files stay memory-safe.
        const PART = 600 * 1024;
        const total = Math.max(1, Math.ceil(file.size / PART));
        let docId: string | undefined;
        let start = 0;
        let part = 0;
        while (start < file.size) {
          const blob = file.slice(start, Math.min(start + PART, file.size));
          const text = await blob.text();
          const res = await api.ingest(title || file.name, text, docId ? { documentId: docId } : undefined);
          docId = res.documentId;
          chunkTotal += res.chunkCount;
          part += 1;
          start += PART;
          setFileProg(`Uploading part ${part}/${total} · ${chunkTotal} chunks embedded`);
        }
      } else {
        setFileProg("Reading file…");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        const STEP = 0x8000;
        for (let i = 0; i < bytes.length; i += STEP) {
          binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
        }
        setFileProg("Parsing & embedding…");
        const res = await api.uploadFile(file.name, btoa(binary), title || file.name);
        chunkTotal = res.chunkCount;
      }
      toast({ kind: "ok", text: `Ingested "${title || file.name}" → ${chunkTotal} chunks` });
      setFile(null);
      setTitle("");
      load();
    } catch (err) {
      toast({ kind: "err", text: (err as Error).message });
    } finally {
      setFileBusy(false);
      setFileProg(null);
      const input = document.getElementById("kb-file-input") as HTMLInputElement | null;
      if (input) input.value = "";
    }
  };

  const ingest = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.ingest(title || "untitled", markdown);
      toast({ kind: "ok", text: `Ingested "${res.title}" → ${res.chunkCount} chunks (${res.embeddingProvider})` });
      setTitle("");
      setMarkdown("");
      load();
    } catch (err) {
      toast({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearching(true);
    try {
      const res = await api.search(query, 6);
      setHits(res.items);
      if (!res.items.length) toast({ kind: "info", text: "No matches — ingest knowledge first" });
    } catch (err) {
      toast({ kind: "err", text: (err as Error).message });
    } finally {
      setSearching(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Knowledge</h2>
        <p>Normalize → OKF parse → chunk → embed (1536d) → pgvector. Search runs the <span className="mono">match_chunks</span> RPC.</p>
      </div>

      <div className="split">
        <form className="card" onSubmit={ingest}>
          <div className="card-title">Ingest document</div>
          <div className="field">
            <label>Title</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pricing FAQ" />
          </div>
          <div className="field">
            <label>Markdown (optional YAML frontmatter)</label>
            <textarea className="textarea" value={markdown} onChange={(e) => setMarkdown(e.target.value)} placeholder="# Paste your FAQ / policy / pricing doc…" />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" disabled={busy || !markdown.trim()}>
              {busy ? <span className="spinner" /> : "Ingest & embed"}
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => { setMarkdown(SAMPLE); setTitle("Acme Pricing FAQ"); }}>
              Load sample
            </button>
          </div>
        </form>

        <div className="card">
          <div className="card-title">Vector search playground</div>
          <form onSubmit={search}>
            <div className="field">
              <label>Query</label>
              <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="how much is a haircut?" />
            </div>
            <button className="btn" disabled={searching || !query.trim()}>
              {searching ? <span className="spinner" /> : "Search (cosine)"}
            </button>
          </form>

          {hits && (
            <div className="mt" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {hits.length === 0 ? (
                <div className="hint">0 results.</div>
              ) : (
                hits.map((h) => (
                  <div key={h.id} className="trace-item">
                    <div className="score-bar" style={{ marginBottom: 6 }}>
                      <span className="badge info">{h.score.toFixed(3)}</span>
                      <span className="score-track"><span className="score-fill" style={{ width: `${Math.max(0, Math.min(1, h.score)) * 100}%` }} /></span>
                    </div>
                    <div style={{ fontSize: 13 }}>{h.content.slice(0, 220)}{h.content.length > 220 ? "…" : ""}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card mt">
        <div className="card-title">Upload document</div>
        <p className="hint" style={{ marginBottom: 10 }}>
          <span className="mono">.md / .txt</span> — any size (streamed in parts) ·{" "}
          <span className="mono">.pdf / .docx</span> — parsed server-side, up to 20MB each
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            id="kb-file-input"
            className="input"
            type="file"
            accept=".md,.markdown,.txt,.text,.csv,.tsv,.json,.log,.pdf,.docx"
            style={{ flex: "1 1 260px" }}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button className="btn btn-primary" disabled={fileBusy || !file} onClick={uploadFile}>
            {fileBusy ? <span className="spinner" /> : "Upload & embed"}
          </button>
        </div>
        {fileProg ? <div className="hint mt">{fileProg}</div> : null}
      </div>

      <div className="card mt">
        <div className="section-row">
          <div className="card-title" style={{ margin: 0 }}>Documents ({docs.length})</div>
          <span className="hint">embeddings land in chunks.embedding vector(1536)</span>
        </div>
        {docs.length === 0 ? (
          <div className="empty">
            <strong>Knowledge base is empty</strong>
            Ingest a document on the left to enable grounded answers.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Title</th><th>Chunks</th><th>Created</th><th>Id</th></tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td><strong>{d.title}</strong></td>
                  <td><span className="badge info">{d.chunkCount}</span></td>
                  <td className="muted">{new Date(d.createdAt).toLocaleString()}</td>
                  <td className="mono muted">{d.id.slice(0, 8)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
