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
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
          <span className="badge" style={{ fontSize: 11, padding: "5px 14px", background: "#000000", color: "#ffffff", border: "1px solid #000000", fontWeight: 700 }}>
            <i className="fa-solid fa-tooth" style={{ marginRight: 4 }} /> Front Desk Calendar
          </span>
          <span className="badge" style={{ fontSize: 11, padding: "5px 14px", background: "#ffffff", color: "#000000", border: "1px solid #e4e4e7", fontWeight: 600 }}>
            <span className="ws-dot" style={{ display: "inline-block", marginRight: 6 }} /> Real-time Patient Ingestion
          </span>
        </div>
        <h2>Patient Appointments &amp; Triage Records</h2>
        <p>
          Live dental appointment scheduling stream. Captures patient symptoms (toothaches, cleanings, cosmetic veneers), contact details, and dental insurance in real-time.
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
            const cap = b.capture || {};
            const data = cap.data ?? {};
            const skipped = new Set(cap.skipped ?? []);
            const isOpen = open === b.id;

            const pType =
              cap.patient_type ||
              (b.notes && b.notes.toLowerCase().includes("existing patient") ? "existing" : "") ||
              (b.notes && b.notes.toLowerCase().includes("new patient") ? "new" : "") ||
              data.patient_status ||
              "";

            const meetingCode =
              cap.meeting_code ||
              (b.notes && b.notes.match(/Code:\s*([A-Z0-9-]+)/i)?.[1]) ||
              "";

            const serviceName =
              cap.service ||
              (b.notes && b.notes.match(/Service:\s*([^|]+)/i)?.[1]?.trim()) ||
              "";

            const doctorName = cap.doctor || "Dr. Shalini Mandapatti, DDS";
            const insurance =
              cap.insurance ||
              (b.notes && b.notes.match(/Insurance:\s*([^|]+)/i)?.[1]?.trim()) ||
              data.insurance_company ||
              "";

            return (
              <div key={b.id} className="booking-row">
                <div className="booking-main">
                  <div>
                    <strong style={{ fontSize: 15 }}>{b.customerName || "Unnamed caller"}</strong>
                    <div className="hint mono" style={{ marginTop: 2 }}>
                      {b.startsAt || "no slot"} {b.contact ? ` · ${b.contact}` : ""}
                    </div>
                  </div>
                  <div className="booking-tags" style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    {meetingCode ? (
                      <span
                        className="badge"
                        style={{
                          background: "#eff6ff",
                          color: "#1d4ed8",
                          border: "1px solid #bfdbfe",
                          fontWeight: 700,
                          fontFamily: "monospace",
                          letterSpacing: "0.5px",
                        }}
                      >
                        <i className="fa-solid fa-qrcode" style={{ marginRight: 4 }} />
                        {meetingCode}
                      </span>
                    ) : null}
                    {pType ? (
                      <span
                        className="badge"
                        style={
                          pType === "existing"
                            ? { background: "#ecfdf5", color: "#047857", border: "1px solid #a7f3d0", fontWeight: 600 }
                            : { background: "#fffbeb", color: "#b45309", border: "1px solid #fde68a", fontWeight: 600 }
                        }
                      >
                        <i
                          className={pType === "existing" ? "fa-solid fa-user-check" : "fa-solid fa-user-plus"}
                          style={{ marginRight: 4 }}
                        />
                        {pType === "existing" ? "Existing Patient" : "New Patient"}
                      </span>
                    ) : null}
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
                    {meetingCode ? (
                      <div className="capture-cell has" style={{ background: "#f8fafc", borderLeft: "3px solid #2563eb" }}>
                        <span className="k">Meeting Check-in Code</span>
                        <span className="v mono" style={{ fontWeight: 700, color: "#1e40af" }}>
                          {meetingCode} (Direct Entry)
                        </span>
                      </div>
                    ) : null}
                    {pType ? (
                      <div className="capture-cell has">
                        <span className="k">Patient Category</span>
                        <span className="v" style={{ fontWeight: 600, textTransform: "capitalize" }}>
                          {pType} Patient (Verified Records)
                        </span>
                      </div>
                    ) : null}
                    {serviceName ? (
                      <div className="capture-cell has">
                        <span className="k">Service / Procedure</span>
                        <span className="v">{serviceName}</span>
                      </div>
                    ) : null}
                    <div className="capture-cell has">
                      <span className="k">Attending Dentist</span>
                      <span className="v">{doctorName}</span>
                    </div>
                    {insurance ? (
                      <div className="capture-cell has">
                        <span className="k">Dental Insurance</span>
                        <span className="v">{insurance}</span>
                      </div>
                    ) : null}
                    {CAPTURE_LABELS.filter(([key]) => key !== "appointment" && key !== "patient_status").map(([key, label]) => {
                      const value = skipped.has(key) ? "not available" : (data[key] ?? "");
                      if (!value && !data[key]) return null;
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