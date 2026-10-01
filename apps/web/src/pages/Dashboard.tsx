import React from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { getWorkspace } from "../lib/session";

interface Stats {
  agents: number;
  documents: number;
  chunks: number;
  conversations: number;
}

export function DashboardPage() {
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [recentDocs, setRecentDocs] = React.useState<{ id: string; title: string; chunkCount: number }[]>([]);
  const [health, setHealth] = React.useState<string>("…");
  const ws = getWorkspace();

  React.useEffect(() => {
    let alive = true;
    Promise.allSettled([api.listAgents(), api.documents(), api.listConversations(), api.health()]).then(([a, d, c, h]) => {
      if (!alive) return;
      const agents = a.status === "fulfilled" ? a.value.total : 0;
      const docs = d.status === "fulfilled" ? d.value.items : [];
      const convos = c.status === "fulfilled" ? c.value.total : 0;
      setStats({ agents, documents: docs.length, chunks: docs.reduce((s, x) => s + x.chunkCount, 0), conversations: convos });
      setRecentDocs(docs.slice(0, 4));
      setHealth(h.status === "fulfilled" ? `${h.value.service} · up` : "unreachable");
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <div className="hero">
        <div>
          <h3>{ws?.name} · voice agent control plane</h3>
          <p>
            Ingest knowledge → pgvector retrieval → grounded answer with citations → voice pipeline.
            Every turn is validated by the response harness before it reaches the caller.
          </p>
        </div>
        <div className="pipeline">
          <span className="pipe-step">Ingest</span>
          <span className="pipe-arrow">→</span>
          <span className="pipe-step">Embed 1536d</span>
          <span className="pipe-arrow">→</span>
          <span className="pipe-step">Retrieve</span>
          <span className="pipe-arrow">→</span>
          <span className="pipe-step">Context</span>
          <span className="pipe-arrow">→</span>
          <span className="pipe-step">Harness</span>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="stat-value">{stats ? stats.agents : "—"}</div>
          <div className="stat-label">Agents</div>
          <div className="stat-delta"><Link to="/agents">configure →</Link></div>
        </div>
        <div className="card">
          <div className="stat-value">{stats ? stats.documents : "—"}</div>
          <div className="stat-label">Documents</div>
          <div className="stat-delta"><Link to="/knowledge">ingest →</Link></div>
        </div>
        <div className="card">
          <div className="stat-value">{stats ? stats.chunks : "—"}</div>
          <div className="stat-label">Vector chunks</div>
          <div className="stat-delta">pgvector · cosine</div>
        </div>
        <div className="card">
          <div className="stat-value">{stats ? stats.conversations : "—"}</div>
          <div className="stat-label">Conversations</div>
          <div className="stat-delta"><Link to="/conversations">open console →</Link></div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-title">Latest knowledge</div>
          {recentDocs.length === 0 ? (
            <div className="empty">
              <strong>No knowledge ingested yet</strong>
              Paste your first document (FAQ, pricing, policy) to ground your agents.
              <div className="mt"><Link className="btn btn-primary btn-sm" to="/knowledge">Ingest document</Link></div>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Document</th><th>Chunks</th></tr>
              </thead>
              <tbody>
                {recentDocs.map((d) => (
                  <tr key={d.id}>
                    <td>{d.title}</td>
                    <td><span className="badge info">{d.chunkCount}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-title">System status</div>
          <table className="table">
            <tbody>
              <tr><td className="muted">API</td><td><span className="badge ok">{health}</span></td></tr>
              <tr><td className="muted">Database</td><td><span className="badge ok">supabase · pgvector</span></td></tr>
              <tr><td className="muted">Backend host</td><td><span className="badge info">railway</span></td></tr>
              <tr><td className="muted">Frontend host</td><td><span className="badge info">vercel</span></td></tr>
              <tr><td className="muted">Voice runtime</td><td><span className="badge warn">pipecat · next milestone</span></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
