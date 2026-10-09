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

export function BrandLogo() {
  return (
    <a href="/" style={{ textDecoration: "none", color: "inherit", display: "flex", alignItems: "center", gap: 10 }}>
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: "50%",
          background: "#000000",
          color: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
        }}
      >
        <i className="fa-solid fa-tooth" style={{ color: "#ffffff", fontSize: 17 }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 15, fontWeight: 900, textTransform: "uppercase", letterSpacing: "-0.03em", lineHeight: 0.95, color: "#000000" }}>
          Dental
        </span>
        <span style={{ fontSize: 15, fontWeight: 900, textTransform: "uppercase", letterSpacing: "-0.03em", lineHeight: 0.95, color: "#000000", marginTop: 2 }}>
          Health
        </span>
        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.06em", color: "#71717a", marginTop: 3 }}>
          QUALITY HEALTHCARE
        </span>
      </div>
    </a>
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
    { to: "/overview", label: "Clinic Overview", ico: "fa-solid fa-house-medical" },
    { to: "/conversations", label: "Call Transcripts", ico: "fa-solid fa-phone-volume" },
  ];
  const title = nav.find((n) => n.to === loc.pathname)?.label ?? "Dental Health Voice AI";

  return (
    <ToastCtx.Provider value={push}>
      <BgScene />
      <div className={`app${menuOpen ? " menu-open" : ""}`}>
        <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
        <aside className="sidebar">
          <div className="brand" style={{ padding: "4px 4px 16px" }}>
            <BrandLogo />
          </div>
          <div className="nav-section">Practice Console</div>
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/overview"}
              className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
            >
              <span className="ico"><i className={n.ico} /></span>
              {n.label}
            </NavLink>
          ))}
          <div className="nav-section">Clinical Intelligence</div>
          <div className="sidebar-clinic-info">
            <div className="clinic-info-item">
              <i className="fa-solid fa-tooth" /> Dental Practice Front Desk
            </div>
            <div className="clinic-info-item">
              <i className="fa-solid fa-calendar-check" /> 24/7 Patient Booking
            </div>
            <div className="clinic-info-item">
              <i className="fa-solid fa-shield-halved" /> PPO &amp; CareCredit Verified
            </div>
          </div>
          <div className="sidebar-footer">
            <div className="ws-chip">
              <span className="ws-dot" />
              <span>{ws?.name ?? "Dental Care Practice"}</span>
            </div>
            <div className="brand-sub mono" style={{ marginTop: 2 }}>
              {user?.email ?? "guest@dentalcare.com"}
            </div>
            <button
              className="link-btn"
              onClick={() => {
                location.reload();
              }}
            >
              <i className="fa-solid fa-rotate" style={{ fontSize: 11 }} />
              <span>Restart session</span>
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
              <a href="/" className="topbar-landing-link" title="Return to Dental Health Clinic Landing Page">
                <i className="fa-solid fa-arrow-left" style={{ fontSize: 10 }} />
                <span>Clinic Landing</span>
              </a>
              <div className="topbar-clinic-banner">
                <span className="clinic-pill"><i className="fa-solid fa-shield-halved" /> Delta Dental &amp; PPO</span>
                <span className="clinic-pill"><i className="fa-solid fa-bolt" /> Sub-400ms Turnaround</span>
              </div>
              <span className={`badge ${health === "up" ? "ok" : health === "down" ? "danger" : "muted"}`}>
                <span className="ws-dot" />
                {health === "checking" ? "checking…" : health === "up" ? "Front Desk Online" : "Front Desk Offline"}
              </span>
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

createRoot(document.getElementById("root")!).render(
  <BrowserRouter basename={BASENAME}>
    <Routes>
      <Route path="/login" element={<Navigate to="/voice" replace />} />
      <Route path="/setup" element={<Navigate to="/voice" replace />} />
      <Route path="/" element={<Navigate to="/voice" replace />} />
      <Route path="/voice" element={<Shell><VoicePage /></Shell>} />
      <Route path="/overview" element={<Shell><DashboardPage /></Shell>} />
      <Route path="/agents" element={<Shell><AgentsPage /></Shell>} />
      <Route path="/knowledge" element={<Shell><KnowledgePage /></Shell>} />
      <Route path="/conversations" element={<Shell><ConversationsPage /></Shell>} />
      <Route path="/bookings" element={<Shell><BookingsPage /></Shell>} />
      <Route path="*" element={<Navigate to="/voice" replace />} />
    </Routes>
  </BrowserRouter>,
);
