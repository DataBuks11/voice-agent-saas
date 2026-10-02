import React from "react";
import { api, ApiError, type WorkspaceLite } from "../lib/api";
import { setWorkspace } from "../lib/session";
import { BASENAME } from "../lib/base";
import { BrandLogo, BgScene } from "../main";

export function SetupPage() {
  const [mode, setMode] = React.useState<"create" | "join">("create");
  const [name, setName] = React.useState("");
  const [existing, setExisting] = React.useState<WorkspaceLite[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .listWorkspaces()
      .then((r) => setExisting(r.items))
      .catch(() => undefined);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        if (name.trim().length < 2) throw new Error("workspace name too short");
        const ws = await api.createWorkspace(name.trim());
        setWorkspace({ id: ws.id, name: ws.name, createdAt: ws.createdAt, role: ws.role });
      } else {
        const picked = existing.find((w) => w.id === selectedJoin);
        if (!picked) throw new Error("select a workspace");
        setWorkspace({ id: picked.id, name: picked.name, createdAt: picked.createdAt, role: picked.role });
      }
      location.href = BASENAME + "/";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const [selectedJoin, setSelectedJoin] = React.useState<string>("");

  return (
    <div className="setup-wrap">
      <BgScene />
      <div className="setup-card card">
        <div className="brand" style={{ padding: "0 0 18px" }}>
          <BrandLogo />
          <div>
            <div className="brand-name">Voice Agent OS</div>
            <div className="brand-sub">create or pick a workspace to continue</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          <button className={`btn btn-sm ${mode === "create" ? "btn-primary" : ""}`} onClick={() => setMode("create")} type="button">
            New workspace
          </button>
          <button className={`btn btn-sm ${mode === "join" ? "btn-primary" : ""}`} onClick={() => setMode("join")} type="button">
            Existing ({existing.length})
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === "create" ? (
            <div className="field">
              <label>Workspace name</label>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Hair Salon"
                autoFocus
              />
            </div>
          ) : (
            <div className="field">
              <label>Your workspaces</label>
              {existing.length === 0 ? (
                <div className="hint">No workspace yet for this browser — create one.</div>
              ) : (
                <select className="select" value={selectedJoin} onChange={(e) => setSelectedJoin(e.target.value)}>
                  <option value="">Select workspace…</option>
                  {existing.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.role})
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {error ? <div className="badge danger" style={{ marginBottom: 12 }}>{error}</div> : null}

          <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy}>
            {busy ? <span className="spinner" /> : mode === "create" ? "Create workspace" : "Open workspace"}
          </button>
        </form>

        <p className="hint mt">
          Auth: simple email + password (scrypt + JWT) — no OTP, no verification emails.
        </p>
      </div>
    </div>
  );
}
