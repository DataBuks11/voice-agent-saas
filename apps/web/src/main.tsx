import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";

function Page({ title }: { title: string }) {
  const [health, setHealth] = React.useState("checking…");
  React.useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/health`)
      .then((r) => (r.ok ? "API reachable" : "API error"))
      .then(setHealth)
      .catch(() => setHealth("API unreachable (start apps/api)"));
  }, []);
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>{title}</h1>
      <p>Status: {health}</p>
      <nav style={{ display: "flex", gap: 12 }}>
        <Link to="/">Dashboard</Link>
        <Link to="/agents">Agents</Link>
        <Link to="/knowledge">Knowledge</Link>
        <Link to="/conversations">Conversations</Link>
      </nav>
      <p>Functional UX first. Visual polish after the RAG→voice pipeline works.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Page title="Dashboard" />} />
      <Route path="/agents" element={<Page title="Agents" />} />
      <Route path="/knowledge" element={<Page title="Knowledge" />} />
      <Route path="/conversations" element={<Page title="Conversations" />} />
    </Routes>
  </BrowserRouter>,
);
