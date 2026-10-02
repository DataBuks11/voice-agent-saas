import React from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { setSession, getToken } from "../lib/session";
import { BrandLogo, BgScene } from "../main";

export function LoginPage() {
  const nav = useNavigate();
  const [mode, setMode] = React.useState<"login" | "register">("login");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (getToken()) nav("/", { replace: true });
  }, [nav]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "login"
          ? await api.login(email.trim(), password)
          : await api.register(email.trim(), password, name.trim() || undefined);
      setSession(res.token, res.user);
      nav("/setup", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-wrap">
      <BgScene />
      <div className="setup-card card">
        <div className="brand" style={{ padding: "0 0 18px" }}>
          <BrandLogo />
          <div>
            <div className="brand-name">Voice Agent OS</div>
            <div className="brand-sub">sign in to your console</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          <button className={`btn btn-sm ${mode === "login" ? "btn-primary" : ""}`} onClick={() => setMode("login")} type="button">
            Sign in
          </button>
          <button className={`btn btn-sm ${mode === "register" ? "btn-primary" : ""}`} onClick={() => setMode("register")} type="button">
            Create account
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === "register" ? (
            <div className="field">
              <label>Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoFocus />
            </div>
          ) : null}
          <div className="field">
            <label>Email</label>
            <input
              className="input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoFocus={mode === "login"}
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              className="input"
              type="password"
              required
              minLength={mode === "register" ? 8 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "min 8 characters" : "••••••••"}
            />
          </div>

          {error ? (
            <div className="badge danger" style={{ marginBottom: 12 }}>
              {error}
            </div>
          ) : null}

          <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy}>
            {busy ? <span className="spinner" /> : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <p className="hint mt">Simple email + password — no OTP, no verification emails.</p>
      </div>
    </div>
  );
}
