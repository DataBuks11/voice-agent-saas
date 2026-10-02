import React from "react";
import { api, type BookingRow } from "../lib/api";
import { useToast } from "../main";

const CAPTURE_LABELS: Array<[string, string]> = [
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["dob", "Date of birth"],
  ["patient_status", "Patient"],
  ["visit_reason", "Reason"],
  ["time_pref", "Preference"],
  ["appointment", "Appointment"],
  ["zip", "Zip code"],
  ["insurance_company", "Insurance"],
  ["member_id", "Member ID"],
  ["plan_holder", "Plan holder"],
  ["caller_relation", "Calling for"],
  ["patient_name", "Patient name"],
  ["patient_age", "Patient age"],
  ["hospital", "Hospital / address"],
  ["caller_phone", "Callback number"],
  ["notes", "Notes"],
];

export function BookingsPage() {
  const toast = useToast();
  const [rows, setRows] = React.useState<BookingRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    api
      .bookings()
      .then((r) => setRows(r.items ?? []))
      .catch((err: Error) => toast({ kind: "err", text: err.message }))
      .finally(() => setLoading(false));
  }, [toast]);

  React.useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <h2>Bookings</h2>
        <p>
          Every appointment the agent booked, with the details it captured while talking — including the ones
          the caller could not provide (shown as <em>not available</em>).
        </p>
      </div>

      <div className="card">
        <div className="section-row">
          <div className="card-title" style={{ margin: 0 }}>
            {loading ? "Loading…" : `${rows.length} booking${rows.length === 1 ? "" : "s"}`}
          </div>
          <button className="btn btn-sm" onClick={load}>
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="empty">Loading bookings…</div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <strong>No bookings yet</strong>
            Ask the agent for an appointment in Conversations, or place one from the Voice page.
          </div>
        ) : (
          rows.map((b) => {
            const data = b.capture?.data ?? {};
            const skipped = new Set(b.capture?.skipped ?? []);
            const isOpen = open === b.id;
            return (
              <div key={b.id} className="booking-row">
                <div className="booking-main">
                  <div>
                    <strong>{b.customerName || "Unnamed caller"}</strong>
                    <div className="hint mono">
                      {b.startsAt || "no slot"} {b.contact ? ` · ${b.contact}` : ""}
                    </div>
                  </div>
                  <div className="booking-tags">
                    <span className="badge">{b.status}</span>
                    <span className="badge info">{b.source}</span>
                    {skipped.size > 0 ? (
                      <span className="badge warn">{skipped.size} not provided</span>
                    ) : null}
                    <button className="btn btn-sm" onClick={() => setOpen(isOpen ? null : b.id)}>
                      {isOpen ? "Hide details" : "Captured details"}
                    </button>
                  </div>
                </div>
                {isOpen ? (
                  <div className="capture-grid">
                    {CAPTURE_LABELS.filter(([key]) => key !== "appointment").map(([key, label]) => {
                      const value = skipped.has(key) ? "not available" : (data[key] ?? "");
                      return (
                        <div key={key} className={`capture-cell ${value ? "has" : "empty"}`}>
                          <span className="k">{label}</span>
                          <span className="v">{value || "—"}</span>
                        </div>
                      );
                    })}
                    <div className="capture-cell has">
                      <span className="k">Appointment</span>
                      <span className="v">{data.appointment ?? b.startsAt ?? "—"}</span>
                    </div>
                    <div className="capture-cell has">
                      <span className="k">Booked at</span>
                      <span className="v mono">{new Date(b.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}