import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, NavLink, useLocation, Navigate } from "react-router-dom";
import "./styles.css";
import { getWorkspace, clearWorkspace, getToken, clearSession, getUser } from "./lib/session";
import { api } from "./lib/api";
import { LoginPage } from "./pages/Login";
import { SetupPage } from "./pages/Setup";
import { DashboardPage } from "./pages/Dashboard";
import { AgentsPage } from "./pages/Agents";
import { KnowledgePage } from "./pages/Knowledge";
import { ConversationsPage } from "./pages/Conversations";
import { BASENAME } from "./lib/base";

export interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  text: string;
}

export const ToastCtx = React.createContext<(t: Omit<Toast, "id">) => void>(() => undefined);

export function useToast() {
  return React.useContext(ToastCtx);
}

function Shell({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const [health, setHealth] = React.useState<"checking" | "up" | "down">("checking");
  const ws = getWorkspace();
  const user = getUser();
  const loc = useLocation();

  const push = React.useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...t, id }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 4200);
  }, []);

  React.useEffect(() => {
    api
      .health()
      .then(() => setHealth("up"))
      .catch(() => setHealth("down"));
  }, [loc.pathname]);

  const nav = [
    { to: "/", label: "Dashboard", ico: "◈" },
    { to: "/agents", label: "Agents", ico: "◉" },
    { to: "/knowledge", label: "Knowledge", ico: "▤" },
    { to: "/conversations", label: "Conversations", ico: "◆" },
  ];

  return (
    <ToastCtx.Provider value={push}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-logo">VA</div>
            <div>
              <div className="brand-name">Voice Agent OS</div>
              <div className="brand-sub">multi-tenant · RAG · voice</div>
            </div>
          </div>
          <div className="nav-section">Workspace</div>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
              <span className="ico">{n.ico}</span>
              {n.label}
            </NavLink>
          ))}
          <div className="nav-section">Runtime</div>
          <a className="nav-link" href={`${api.base}/health`} target="_blank" rel="noreferrer">
            <span className="ico">◍</span>
            API health
          </a>
          <div className="sidebar-footer">
            <div className="ws-chip">
              <span className="ws-dot" />
              <span>{ws?.name ?? "no workspace"}</span>
            </div>
            <div className="brand-sub mono" style={{ marginTop: 4 }}>
              {user?.email ?? ""}
            </div>
            <button
              className="link-btn"
              onClick={() => {
                clearSession();
                clearWorkspace();
                location.href = BASENAME + "/login";
              }}
            >
              Sign out
            </button>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <h1>{nav.find((n) => n.to === loc.pathname)?.label ?? "Voice Agent OS"}</h1>
            <div className="topbar-right">
              <span className={`badge ${health === "up" ? "ok" : health === "down" ? "danger" : "muted"}`}>
                {health === "checking" ? "checking api…" : health === "up" ? "api online" : "api offline"}
              </span>
              <span className="badge muted">{user?.email ?? "signed out"}</span>
            </div>
          </header>
          <main className="content">{children}</main>
        </div>
        <div className="toast-wrap">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
          ))}
        </div>
      </div>
    </ToastCtx.Provider>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  if (!getWorkspace()) return <Navigate to="/setup" replace />;
  return <>{children}</>;
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter basename={BASENAME}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/" element={<Shell><RequireAuth><DashboardPage /></RequireAuth></Shell>} />
      <Route path="/agents" element={<Shell><RequireAuth><AgentsPage /></RequireAuth></Shell>} />
      <Route path="/knowledge" element={<Shell><RequireAuth><KnowledgePage /></RequireAuth></Shell>} />
      <Route path="/conversations" element={<Shell><RequireAuth><ConversationsPage /></RequireAuth></Shell>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </BrowserRouter>,
);
