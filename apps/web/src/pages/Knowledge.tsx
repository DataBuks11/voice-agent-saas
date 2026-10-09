import React from "react";
import { api, type DocumentRow, type SearchHit } from "../lib/api";
import { useToast } from "../main";

const DENTAL_PROCEDURES_SAMPLE = `---
title: Dental Care Practice — Clinical Procedures & Fees
category: clinical_services
practice: Dental Care Clinic
---

# Practice Overview
Our dental clinic provides comprehensive, gentle, and modern dental care for patients of all ages. We offer full diagnostic, preventive, restorative, and cosmetic dental treatments.

# Comprehensive Exams & Preventive Care
- Comprehensive New Patient Dental Exam & Digital X-Rays: Clinical examination, low-radiation digital imaging, and oral cancer screening.
- Adult Dental Prophylaxis (Routine Cleaning): Ultrasonic tartar and plaque removal followed by enamel polishing.
- Deep Cleaning (Scaling & Root Planing): Non-surgical periodontal gum therapy for gingivitis and periodontal care.

# Emergency Dental Care (Same-Day Relief)
- Same-day emergency appointments for severe toothaches, chipped or cracked teeth, knocked-out teeth, lost fillings/crowns, or acute dental abscesses.

# Restorative & Implant Dentistry
- Dental Implants: Titanium tooth root replacement with custom porcelain dental crowns.
- Custom Porcelain Crowns & Bridges: Natural-looking tooth restoration and broken tooth repair.
- Tooth-Colored Composite Fillings: Mercury-free, aesthetic composite fillings matching natural enamel.

# Cosmetic Dentistry & Orthodontics
- Professional Teeth Whitening: In-office whitening brightening enamel up to 8 shades in 60 minutes.
- Custom Porcelain Veneers: Corrects deep discoloration, chips, minor gaps, and enamel wear.
- Clear Aligners: Discrete orthodontic straightening for teens and adults.`;

const DENTAL_INSURANCE_SAMPLE = `---
title: Dental Care Practice — Insurance & Patient Financing
category: insurance_billing
practice: Dental Care Clinic
---

# In-Network PPO Dental Insurances
We accept and work with leading dental insurance plans:
- Delta Dental (Premier & PPO)
- MetLife Dental
- Cigna Dental
- Aetna Dental
- Guardian Dental
- United Healthcare Dental
- Ameritas

Our front desk team files all insurance claims electronically on behalf of patients to maximize benefit coverage.

# Flexible Patient Financing (CareCredit)
- We partner with CareCredit to offer flexible monthly payment options, including 0% introductory APR financing for 6, 12, or 24 months.
- Instant approval with no upfront prepayment penalties.

# Self-Pay & Uninsured Patients
- 100% transparent pricing with no hidden charges.
- Transparent fee estimates provided prior to initiating any treatment.
- Accepted payment methods: Cash, Visa, MasterCard, American Express, Discover, debit cards, and HSA / FSA health savings accounts.`;

const DENTAL_HOURS_LOCATION_SAMPLE = `---
title: Dental Care Practice — Office Hours & Booking Protocols
category: practice_operations
practice: Dental Care Clinic
---

# Operating Hours & Availability
- Monday – Friday: 9:00 AM – 6:00 PM
- Saturday: 9:00 AM – 2:00 PM
- Sunday: Emergency dental triage & urgent visits by appointment
- 24/7 Virtual Front Desk: Round-the-clock appointment scheduling with our AI receptionist Sarah.

# Patient Appointment Protocol
- Check-in: Please arrive 10 to 15 minutes prior to scheduled time for registration and health history review.
- Cancellations: Please give at least 24 hours advance notice if you need to reschedule so we can offer the appointment to another patient in need.
- Emergency Walk-ins: Please call the front desk before coming in so we can prepare a treatment room immediately.`;

const isDentalContent = (text: string, titleStr: string): boolean => {
  const combined = `${titleStr} ${text}`.toLowerCase();
  const dentalKeywords = [
    "dental", "dentist", "tooth", "teeth", "hygiene", "cleaning", "prophylaxis",
    "cavity", "crown", "implant", "veneer", "root canal", "enamel", "gum", "oral",
    "ortho", "invisalign", "caries", "periodont", "extraction", "denture", "whitening",
    "filling", "carecredit", "delta dental", "metlife", "cigna", "aetna", "clinic",
    "patient", "checkup", "exam", "x-ray", "braces", "copay", "doctor", "dds"
  ];
  return dentalKeywords.some((kw) => combined.includes(kw));
};

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
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    api
      .documents()
      .then((r) => setDocs(r.items))
      .catch((e) => toast({ kind: "err", text: e.message }));
  }, [toast]);

  const handleDelete = async (id: string, docTitle: string) => {
    if (!window.confirm(`Delete "${docTitle}" and all its vector chunks?`)) return;
    setDeletingId(id);
    try {
      await api.deleteDocument(id);
      toast({ kind: "ok", text: `Deleted "${docTitle}"` });
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      toast({ kind: "err", text: (err as Error).message });
    } finally {
      setDeletingId(null);
    }
  };

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
        const textSample = await file.slice(0, 4000).text();
        if (!isDentalContent(textSample, file.name)) {
          toast({
            kind: "err",
            text: "Validation rejected: Only dental clinic documents and clinical protocols are permitted in the knowledge base.",
          });
          setFileBusy(false);
          setFileProg(null);
          return;
        }

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
      toast({ kind: "ok", text: `Ingested dental document "${title || file.name}" → ${chunkTotal} chunks` });
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
    if (!isDentalContent(markdown, title)) {
      toast({
        kind: "err",
        text: "Domain restricted: Only dental care, clinical procedures, or practice documents are permitted.",
      });
      return;
    }

    setBusy(true);
    try {
      const res = await api.ingest(title || "Dental Practice Protocol", markdown);
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
      if (!res.items.length) toast({ kind: "info", text: "No matching dental records found — ingest dental knowledge first" });
    } catch (err) {
      toast({ kind: "err", text: (err as Error).message });
    } finally {
      setSearching(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
          <span className="badge" style={{ fontSize: 11, padding: "5px 14px", background: "#000000", color: "#ffffff", border: "1px solid #000000", fontWeight: 700 }}>
            <i className="fa-solid fa-tooth" style={{ marginRight: 4 }} /> Dental Knowledge Harness
          </span>
          <span className="badge" style={{ fontSize: 11, padding: "5px 14px", background: "#ffffff", color: "#000000", border: "1px solid #e4e4e7", fontWeight: 600 }}>
            <span className="ws-dot" style={{ display: "inline-block", marginRight: 6 }} /> pgvector Embeddings Active
          </span>
        </div>
        <h2>Dental Care Clinical Knowledge Base</h2>
        <p>
          Strictly grounded on dental care guidelines, clinical procedures,
          in-network dental insurance, and practice policies. Only dental documents are indexed.
        </p>
      </div>

      <div className="dental-notice-bar" style={{
        background: "#ffffff",
        border: "1px solid #e4e4e7",
        borderRadius: 16,
        padding: "14px 20px",
        marginBottom: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        boxShadow: "var(--shadow-sm)"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <i className="fa-solid fa-shield-halved" style={{ color: "#000000", fontSize: 16 }} />
          <span style={{ fontSize: 13, color: "#18181b" }}>
            <strong>Dental Care Domain Filter Active:</strong> Only dental procedures, insurance coverage, oral hygiene, and clinic operating policies are indexed to guarantee 100% accurate patient communication.
          </span>
        </div>
        <span className="badge ok">Dental Clinic Verified</span>
      </div>

      <div className="split">
        <form className="card" onSubmit={ingest}>
          <div className="card-title">Ingest Dental Document</div>
          <div className="field">
            <label>Title</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Dental Practice — Cosmetic & Whitening Protocol"
            />
          </div>
          <div className="field">
            <label>Markdown (Procedures, Insurance, or Office Guidelines)</label>
            <textarea
              className="textarea"
              style={{ minHeight: 140 }}
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              placeholder="# Paste dental clinical guidelines, accepted insurances, fees, or emergency triage rules…"
            />
          </div>
          
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#71717a", fontWeight: 700, marginBottom: 8 }}>
              Quick Clinical Dental Templates:
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                className="btn btn-sm btn-ghost quick-pill-btn"
                type="button"
                onClick={() => {
                  setTitle("Dental Care Practice — Clinical Procedures & Fees");
                  setMarkdown(DENTAL_PROCEDURES_SAMPLE);
                }}
              >
                🦷 Procedures & Fees
              </button>
              <button
                className="btn btn-sm btn-ghost quick-pill-btn"
                type="button"
                onClick={() => {
                  setTitle("Dental Care Practice — Insurance & Patient Financing");
                  setMarkdown(DENTAL_INSURANCE_SAMPLE);
                }}
              >
                💳 Insurance & CareCredit
              </button>
              <button
                className="btn btn-sm btn-ghost quick-pill-btn"
                type="button"
                onClick={() => {
                  setTitle("Dental Care Practice — Office Hours & Booking Protocols");
                  setMarkdown(DENTAL_HOURS_LOCATION_SAMPLE);
                }}
              >
                🏥 Hours & Booking Protocols
              </button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" disabled={busy || !markdown.trim()}>
              {busy ? <span className="spinner" /> : "Ingest & embed into pgvector"}
            </button>
          </div>
        </form>

        <div className="card">
          <div className="card-title">Dental Vector Search Playground</div>
          <form onSubmit={search}>
            <div className="field">
              <label>Patient Inquiry Query</label>
              <input
                className="input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. Do you accept Delta Dental or CareCredit financing?"
              />
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-sm btn-ghost quick-pill-btn"
                onClick={() => setQuery("Do you accept Delta Dental or CareCredit?")}
              >
                Delta Dental & CareCredit?
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost quick-pill-btn"
                onClick={() => setQuery("What are your clinic operating hours and check-in protocols?")}
              >
                Clinic Hours & Check-in?
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost quick-pill-btn"
                onClick={() => setQuery("Emergency toothache and same day appointment?")}
              >
                Emergency Toothache?
              </button>
            </div>
            <button className="btn btn-primary" disabled={searching || !query.trim()}>
              {searching ? <span className="spinner" /> : "Search Dental Knowledge (cosine)"}
            </button>
          </form>

          {hits && (
            <div className="mt" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {hits.length === 0 ? (
                <div className="hint">0 matching dental results found.</div>
              ) : (
                hits.map((h) => (
                  <div key={h.id} className="trace-item">
                    <div className="score-bar" style={{ marginBottom: 6 }}>
                      <span className="badge info">{h.score.toFixed(3)}</span>
                      <span className="score-track"><span className="score-fill" style={{ width: `${Math.max(0, Math.min(1, h.score)) * 100}%` }} /></span>
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>{h.content.slice(0, 240)}{h.content.length > 240 ? "…" : ""}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      <div className="card mt">
        <div className="card-title">Upload Dental Practice Document</div>
        <p className="hint" style={{ marginBottom: 10 }}>
          <span className="mono">.md / .txt</span> — verified dental clinical guidelines & fee schedules ·{" "}
          <span className="mono">.pdf / .docx</span> — parsed server-side (up to 20MB)
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
            {fileBusy ? <span className="spinner" /> : "Upload & embed dental doc"}
          </button>
        </div>
        {fileProg ? <div className="hint mt">{fileProg}</div> : null}
      </div>

      <div className="card mt">
        <div className="section-row">
          <div className="card-title" style={{ margin: 0 }}>
            Indexed Dental Documents ({docs.length})
          </div>
          <span className="hint">Verified clinical knowledge in pgvector (1536-dimensional embeddings)</span>
        </div>
        {docs.length === 0 ? (
          <div className="empty">
            <strong>Knowledge base is empty</strong>
            Ingest a dental care document above to enable grounded patient answers for Sarah.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Title</th><th>Category</th><th>Chunks</th><th>Indexed</th><th>Id</th><th>Action</th></tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 16 }}>🦷</span>
                      <strong>{d.title}</strong>
                    </div>
                  </td>
                  <td>
                    <span className="badge info">
                      {d.title.toLowerCase().includes("insurance") ? "Insurance & Billing" :
                       d.title.toLowerCase().includes("procedure") ? "Clinical Services" :
                       d.title.toLowerCase().includes("overview") || d.title.toLowerCase().includes("hour") ? "Practice Protocols" :
                       "Dental Knowledge"}
                    </span>
                  </td>
                  <td><span className="badge ok">{d.chunkCount} chunks</span></td>
                  <td className="muted">{new Date(d.createdAt).toLocaleDateString()}</td>
                  <td className="mono muted">{d.id.slice(0, 8)}…</td>
                  <td>
                    <button
                      className="btn btn-sm btn-ghost"
                      style={{ color: "#ef4444", padding: "3px 8px" }}
                      onClick={() => handleDelete(d.id, d.title)}
                      disabled={deletingId === d.id}
                      title={`Delete "${d.title}"`}
                    >
                      {deletingId === d.id ? <span className="spinner" /> : <><i className="fa-solid fa-trash" /> Delete</>}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
