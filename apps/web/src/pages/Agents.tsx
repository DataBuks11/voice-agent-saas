import React from "react";
import { Link } from "react-router-dom";
import { api, type AgentRow } from "../lib/api";
import { useToast } from "../main";

const DEFAULT_FORM = {
  name: "Dental Care Receptionist",
  language: "en",
  tone: "warm",
  systemPrompt:
    "You are Sarah, the dedicated front desk receptionist for our dental clinic. You speak natural Native American English with a warm, caring bedside manner. You assist patients with dental appointment bookings, cleanings, cosmetic treatments (veneers, whitening), implants, emergency toothache relief, and dental insurance queries.",
  fallbackResponse: "I'd be glad to have our front desk team verify that directly for you.",
  location: "100 Dental Care Plaza, Suite 200",
};

export function AgentsPage() {
  const toast = useToast();
  const [items, setItems] = React.useState<AgentRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [form, setForm] = React.useState(DEFAULT_FORM);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    api
      .listAgents()
      .then((r) => setItems(r.items))
      .catch((e) => toast({ kind: "err", text: e.message }))
      .finally(() => setLoading(false));
  }, [toast]);

  React.useEffect(load, [load]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      if (editingId) {
        await api.updateAgent(editingId, form);
        toast({ kind: "ok", text: `Agent "${form.name}" updated successfully` });
        setEditingId(null);
      } else {
        await api.createAgent(form);
        toast({ kind: "ok", text: `Agent "${form.name}" created successfully` });
      }
      setForm(DEFAULT_FORM);
      load();
    } catch (err) {
      toast({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (a: AgentRow) => {
    setEditingId(a.id);
    setForm({
      name: a.name,
      language: a.language || "en",
      tone: a.tone || "professional",
      systemPrompt: a.systemPrompt || DEFAULT_FORM.systemPrompt,
      fallbackResponse: a.fallbackResponse || DEFAULT_FORM.fallbackResponse,
      location: a.location || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(DEFAULT_FORM);
  };

  const handleDelete = async (a: AgentRow) => {
    if (!window.confirm(`Are you sure you want to delete agent "${a.name}"?`)) return;
    setDeletingId(a.id);
    try {
      await api.deleteAgent(a.id);
      toast({ kind: "ok", text: `Agent "${a.name}" deleted` });
      if (editingId === a.id) {
        cancelEdit();
      }
      setItems((prev) => prev.filter((item) => item.id !== a.id));
    } catch (err) {
      toast({ kind: "err", text: (err as Error).message });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
          <span className="badge" style={{ fontSize: 11, padding: "5px 14px", background: "#000000", color: "#ffffff", border: "1px solid #000000", fontWeight: 700 }}>
            <i className="fa-solid fa-user-doctor" style={{ marginRight: 4 }} /> AI Front Desk Receptionist
          </span>
          <span className="badge" style={{ fontSize: 11, padding: "5px 14px", background: "#ffffff", color: "#000000", border: "1px solid #e4e4e7", fontWeight: 600 }}>
            <span className="ws-dot" style={{ display: "inline-block", marginRight: 6 }} /> Native American Voice AI
          </span>
        </div>
        <h2>AI Receptionist Personality &amp; Protocols</h2>
        <p>Tenant-scoped voice agent configuration: clinical dental persona, bedside manner, appointment booking prompts, and practice fallback protocols.</p>
      </div>

      <div className="split">
        <div className="card">
          <div className="section-row" style={{ marginBottom: 12 }}>
            <div className="card-title" style={{ margin: 0 }}>Configured agents ({items.length})</div>
            <span className="hint">Select an agent in the Voice Console to converse live</span>
          </div>

          {loading ? (
            <div className="center muted" style={{ padding: 24 }}><span className="spinner" /></div>
          ) : items.length === 0 ? (
            <div className="empty">
              <strong>No agents yet</strong>
              Create one — it becomes the voice personality and decision harness for this workspace.
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Language</th>
                  <th>Tone</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} style={editingId === a.id ? { background: "#f4f4f5" } : undefined}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <strong>{a.name}</strong>
                        {editingId === a.id ? <span className="badge warn">Editing</span> : null}
                      </div>
                      <div className="mono muted" style={{ fontSize: 11 }}>{a.id.slice(0, 8)}…</div>
                      {a.systemPrompt ? (
                        <div className="muted" style={{ fontSize: 11, marginTop: 4, maxWidth: 280, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={a.systemPrompt}>
                          {a.systemPrompt}
                        </div>
                      ) : null}
                    </td>
                    <td><span className="badge muted">{a.language}</span></td>
                    <td><span className="badge info">{a.tone}</span></td>
                    <td>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <Link
                          to={`/voice?agentId=${a.id}`}
                          className="btn btn-sm btn-ghost"
                          title="Open this agent in the Voice Console"
                          style={{ padding: "4px 8px", fontSize: 11 }}
                        >
                          <i className="fa-solid fa-microphone" /> Test
                        </Link>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => startEdit(a)}
                          title="Edit this agent"
                          style={{ padding: "4px 8px", fontSize: 11 }}
                        >
                          <i className="fa-solid fa-pen-to-square" /> Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => handleDelete(a)}
                          disabled={deletingId === a.id}
                          title="Delete this agent"
                          style={{ padding: "4px 8px", fontSize: 11 }}
                        >
                          {deletingId === a.id ? <span className="spinner" /> : <i className="fa-solid fa-trash" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <form className="card" onSubmit={handleSubmit}>
          <div className="section-row" style={{ marginBottom: 12 }}>
            <div className="card-title" style={{ margin: 0 }}>
              {editingId ? `Edit Agent: ${form.name}` : "New agent"}
            </div>
            {editingId ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={cancelEdit}>
                Cancel
              </button>
            ) : null}
          </div>

          <div className="field">
            <label>Name</label>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Apex Dental Care Receptionist"
              required
            />
          </div>

          <div className="field">
            <label>Language</label>
            <select
              className="select"
              value={form.language}
              onChange={(e) => setForm({ ...form, language: e.target.value })}
            >
              <option value="en">English (en)</option>
              <option value="en-IN">English · India (en-IN)</option>
              <option value="hi">Hindi (hi)</option>
              <option value="mr">Marathi (mr)</option>
              <option value="es">Spanish (es)</option>
            </select>
          </div>

          <div className="field">
            <label>Tone</label>
            <select
              className="select"
              value={form.tone}
              onChange={(e) => setForm({ ...form, tone: e.target.value })}
            >
              <option value="professional">professional</option>
              <option value="friendly">friendly</option>
              <option value="concise">concise</option>
              <option value="warm">warm</option>
            </select>
          </div>

          <div className="field">
            <label>System prompt</label>
            <textarea
              className="textarea"
              style={{ minHeight: 96 }}
              value={form.systemPrompt}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            />
          </div>

          <div className="field">
            <label>Fallback response</label>
            <input
              className="input"
              value={form.fallbackResponse}
              onChange={(e) => setForm({ ...form, fallbackResponse: e.target.value })}
            />
          </div>

          <div className="field">
            <label>Business address (powers Google Maps)</label>
            <input
              className="input"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              placeholder="229 Plaza Blvd, Suite 23, Morrisville, PA 19067"
            />
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !form.name.trim()}
              style={{ flex: 1 }}
            >
              {busy ? <span className="spinner" /> : editingId ? "Save changes" : "Create agent"}
            </button>
            {editingId ? (
              <button type="button" className="btn btn-ghost" onClick={cancelEdit}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </>
  );
}
