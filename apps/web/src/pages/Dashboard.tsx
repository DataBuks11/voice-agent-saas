import React from "react";
import { Link } from "react-router-dom";
import { api, type BookingRow } from "../lib/api";
import { getWorkspace } from "../lib/session";

interface Stats {
  agents: number;
  documents: number;
  chunks: number;
  conversations: number;
  bookings: number;
}

function bookingCalendarUrl(b: BookingRow): string | null {
  const m = b.startsAt.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 30 * 60000);
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}00`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `Appointment — ${b.customerName || "customer"}`,
    dates: `${fmt(start)}/${fmt(end)}`,
    details: `Contact: ${b.contact || "-"}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function DashboardPage() {
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [recentDocs, setRecentDocs] = React.useState<{ id: string; title: string; chunkCount: number }[]>([]);
  const [bookings, setBookings] = React.useState<BookingRow[]>([]);
  const [health, setHealth] = React.useState<string>("…");
  const ws = getWorkspace();

  React.useEffect(() => {
    let alive = true;
    Promise.allSettled([api.listAgents(), api.documents(), api.listConversations(), api.health(), api.bookings()]).then(
      ([a, d, c, h, b]) => {
        if (!alive) return;
        const agents = a.status === "fulfilled" ? a.value.total : 0;
        const docs = d.status === "fulfilled" ? d.value.items : [];
        const convos = c.status === "fulfilled" ? c.value.total : 0;
        const book = b.status === "fulfilled" ? b.value.items : [];
        setStats({ agents, documents: docs.length, chunks: docs.reduce((s, x) => s + x.chunkCount, 0), conversations: convos, bookings: book.length });
        setRecentDocs(docs.slice(0, 4));
        setBookings(book.slice(0, 5));
        setHealth(h.status === "fulfilled" ? `${h.value.service} · up` : "unreachable");
      },
    );
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
            Ingest what your business knows, and the agent answers from it — with citations, a
            response harness in front of every turn, and a live voice pipeline on top. Nothing is
            made up: retrieval decides what the model is allowed to say.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, alignItems: "flex-start" }}>
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
          <Link className="btn btn-primary" to="/voice">
            <i className="fa-solid fa-microphone" /> Test the voice agent
          </Link>
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

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-row">
          <div className="card-title" style={{ margin: 0 }}>
            Bookings {stats ? `(${stats.bookings})` : ""}
          </div>
          <span className="hint">agent books via chat & voice · add to Google Calendar in one click</span>
        </div>
        {bookings.length === 0 ? (
          <div className="hint">
            No bookings yet — say “book a haircut for tomorrow at 5pm” in the console or on the voice page.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>When</th><th>Customer</th><th>Contact</th><th>Status</th><th>Calendar</th></tr>
            </thead>
            <tbody>
              {bookings.map((b) => {
                const cal = bookingCalendarUrl(b);
                return (
                  <tr key={b.id}>
                    <td><strong>{b.startsAt || "—"}</strong></td>
                    <td>{b.customerName || "—"}</td>
                    <td className="muted">{b.contact || "—"}</td>
                    <td><span className="badge ok">{b.status}</span></td>
                    <td>
                      {cal ? (
                        <a className="btn btn-sm" href={cal} target="_blank" rel="noreferrer">
                          <i className="fa-solid fa-calendar-plus" /> Add
                        </a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
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
              <tr><td className="muted">Voice runtime</td><td><span className="badge ok">wss · whisper + piper · live</span></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
