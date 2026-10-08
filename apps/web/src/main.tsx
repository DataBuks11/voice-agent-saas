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
import { VoicePage } from "./pages/Voice";
import { BookingsPage } from "./pages/Bookings";
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

const LOGO = `${import.meta.env.BASE_URL}logo.webp`;
const BG_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4";

export function BrandLogo({ size = 38 }: { size?: number }) {
  return (
    <div
      className="brand-logo"
      style={{
        width: size,
        height: size,
        background: "linear-gradient(135deg, #0284c7 0%, #00b4d8 50%, #06d6a0 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "12px",
        boxShadow: "0 0 16px rgba(0, 180, 216, 0.4)",
      }}
    >
      <i className="fa-solid fa-tooth" style={{ color: "#ffffff", fontSize: size * 0.52 }} />
    </div>
  );
}

export function BgScene() {
  return (
    <div className="bg-scene" aria-hidden="true">
      <div className="bg-dental-gradient" />
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const [health, setHealth] = React.useState<"checking" | "up" | "down">("checking");
  const [menuOpen, setMenuOpen] = React.useState(false);
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

  React.useEffect(() => setMenuOpen(false), [loc.pathname]);

  const nav = [
    { to: "/voice", label: "Front Desk (Voice)", ico: "fa-solid fa-microphone-lines" },
    { to: "/bookings", label: "Patient Bookings", ico: "fa-solid fa-calendar-check" },
    { to: "/knowledge", label: "Dental Knowledge", ico: "fa-solid fa-tooth" },
    { to: "/agents", label: "AI Receptionist", ico: "fa-solid fa-user-doctor" },
    { to: "/", label: "Clinic Overview", ico: "fa-solid fa-house-medical" },
    { to: "/conversations", label: "Call Transcripts", ico: "fa-solid fa-phone-volume" },
  ];
  const title = nav.find((n) => n.to === loc.pathname)?.label ?? "Allright Dental Voice AI";

  return (
    <ToastCtx.Provider value={push}>
      <BgScene />
      <div className={`app${menuOpen ? " menu-open" : ""}`}>
        <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
        <aside className="sidebar">
          <div className="brand">
            <BrandLogo />
            <div>
              <div className="brand-name">Allright Dental</div>
              <div className="brand-sub">Dr. Mandapatti, DDS · AI Front Desk</div>
            </div>
          </div>
          <div className="nav-section">Practice Console</div>
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
            >
              <span className="ico"><i className={n.ico} /></span>
              {n.label}
            </NavLink>
          ))}
          <div className="nav-section">Clinical Info</div>
          <div className="sidebar-clinic-info">
            <div className="clinic-info-item">
              <i className="fa-solid fa-location-dot" /> 229 Plaza Blvd, Ste 23, Morrisville, PA
            </div>
            <div className="clinic-info-item">
              <i className="fa-solid fa-phone" /> (215) 295-1348
            </div>
            <div className="clinic-info-item">
              <i className="fa-solid fa-clock" /> Wed–Sat 10am–7pm
            </div>
          </div>
          <div className="sidebar-footer">
            <div className="ws-chip">
              <span className="ws-dot" />
              <span>{ws?.name ?? "Allright Dental Practice"}</span>
            </div>
            <div className="brand-sub mono" style={{ marginTop: 6 }}>
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
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                className="app-burger"
                type="button"
                aria-label="Toggle menu"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <span></span><span></span><span></span>
              </button>
              <h1>{title}</h1>
            </div>
            <div className="topbar-right">
              <div className="topbar-clinic-banner">
                <span className="clinic-pill"><i className="fa-solid fa-shield-halved" /> Delta Dental &amp; PPO</span>
                <span className="clinic-pill"><i className="fa-solid fa-bolt" /> Sub-400ms Turnaround</span>
              </div>
              <span className={`badge ${health === "up" ? "ok" : health === "down" ? "danger" : "muted"}`}>
                {health === "checking" ? "checking…" : health === "up" ? "front desk online" : "front desk offline"}
              </span>
              <span className="badge muted">{user?.email ?? "reception"}</span>
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
      <Route path="/voice" element={<Shell><RequireAuth><VoicePage /></RequireAuth></Shell>} />
      <Route path="/agents" element={<Shell><RequireAuth><AgentsPage /></RequireAuth></Shell>} />
      <Route path="/knowledge" element={<Shell><RequireAuth><KnowledgePage /></RequireAuth></Shell>} />
      <Route path="/conversations" element={<Shell><RequireAuth><ConversationsPage /></RequireAuth></Shell>} />
  <Route path="/bookings" element={<Shell><RequireAuth><BookingsPage /></RequireAuth></Shell>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </BrowserRouter>,
);
