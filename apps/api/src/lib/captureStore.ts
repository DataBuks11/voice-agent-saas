/** Persistence for the front-desk capture flow and pronunciation-safe customers. */
import { getSupabase } from "./supabase.js";
import { phoneticKey, resolveCanonicalName, titleCase } from "./phonetics.js";
import { emptyState, summarize, type CaptureState } from "./captureFlow.js";

const nameCache = new Map<string, { names: string[]; at: number }>();
const NAME_CACHE_MS = Number(process.env.NAME_CACHE_MS ?? 60000);

/**
 * Fallback store used when the capture_sessions table is not migrated yet (or a
 * DB blip): the flow keeps working for the lifetime of the process instead of
 * dropping the caller mid-booking.
 */
const memoryStore = new Map<string, CaptureState>();
const dbAvailable = { ok: true };

export async function loadCaptureState(conversationId: string, workspaceId: string): Promise<CaptureState | null> {
  if (!dbAvailable.ok) return memoryStore.get(conversationId) ?? null;
  const db = getSupabase();
  const { data, error } = await db
    .from("capture_sessions")
    .select("intent,status,step,data,skipped")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) {
    if (/does not exist|schema cache|42P01/i.test(error.message)) {
      dbAvailable.ok = false;
      console.warn("capture_sessions table missing — using in-memory capture state (run migration 0005)");
      return memoryStore.get(conversationId) ?? null;
    }
    console.error(`capture state load failed: ${error.message}`);
    return null;
  }
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const status = String(row.status) as CaptureState["status"];
  return {
    active: status === "capturing" || status === "confirming",
    intent: String(row.intent),
    step: Number(row.step),
    status,
    data: (row.data ?? {}) as Record<string, string>,
    skipped: (row.skipped ?? []) as string[],
    updatedAt: new Date().toISOString(),
  };
}

export async function saveCaptureState(
  conversationId: string,
  workspaceId: string,
  state: CaptureState,
): Promise<void> {
  if (!dbAvailable.ok) {
    memoryStore.set(conversationId, state);
    return;
  }
  const db = getSupabase();
  const row = {
    conversation_id: conversationId,
    workspace_id: workspaceId,
    intent: state.intent,
    status: state.status,
    step: state.step,
    data: state.data,
    skipped: state.skipped,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db
    .from("capture_sessions")
    .upsert(row, { onConflict: "conversation_id" });
  if (error) {
    if (/does not exist|schema cache|42P01/i.test(error.message)) {
      dbAvailable.ok = false;
      console.warn("capture_sessions table missing — using in-memory capture state (run migration 0005)");
      memoryStore.set(conversationId, state);
      return;
    }
    console.error(`capture state save failed: ${error.message}`);
  }
}

export async function clearCaptureState(conversationId: string): Promise<void> {
  memoryStore.delete(conversationId);
  if (!dbAvailable.ok) return;
  const db = getSupabase();
  const { error } = await db
    .from("capture_sessions")
    .update({ status: "done", updated_at: new Date().toISOString() })
    .eq("conversation_id", conversationId);
  if (error) console.error(`capture state clear failed: ${error.message}`);
}

/** Names already known in this workspace — the canonical spelling dictionary. */
export async function knownNames(workspaceId: string): Promise<string[]> {
  const hit = nameCache.get(workspaceId);
  if (hit && Date.now() - hit.at < NAME_CACHE_MS) return hit.names;
  const db = getSupabase();
  const { data } = await db
    .from("customers")
    .select("display_name,metadata")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(200);
  const names = new Set<string>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const n = String(row.display_name ?? "").trim();
    if (n) names.add(n);
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const metaName = String(meta.first_name ?? "").trim();
    if (metaName) names.add(metaName);
  }
  const list = [...names];
  nameCache.set(workspaceId, { names: list, at: Date.now() });
  return list;
}

/** Resolve a spoken name to the workspace's canonical spelling (homophone-safe). */
export async function canonicalName(
  workspaceId: string,
  spoken: string,
): Promise<{ canonical: string; matched: boolean; confidence: number }> {
  const known = await knownNames(workspaceId);
  const match = await resolveCanonicalName(spoken, { known, minConfidence: 0.86 });
  return { canonical: match.canonical, matched: match.matched, confidence: match.confidence };
}

export interface BookingWrite {
  workspaceId: string;
  conversationId: string;
  customerName: string;
  contact: string;
  startsAt: string;
  notes: string;
  capture: CaptureState;
}

/**
 * Persist the finished capture: one canonical customer row (deduped by phonetic
 * key so "Sudhansu"/"Sudhanshu" never split) plus the booking with its details.
 */
export async function persistCapture(write: BookingWrite): Promise<{ customerId: string | null; bookingId: string | null }> {
  const db = getSupabase();
  const data = write.capture.data;
  const first = titleCase(data.first_name ?? "");
  const last = titleCase(data.last_name ?? "");
  const full = [first, last].filter(Boolean).join(" ");
  const key = phoneticKey(full);

  let customerId: string | null = null;
  if (full) {
    const { data: existing } = await db
      .from("customers")
      .select("id")
      .eq("workspace_id", write.workspaceId)
      .eq("phon_key", key)
      .limit(1)
      .maybeSingle();
    if (existing) {
      customerId = String((existing as Record<string, unknown>).id);
    } else {
      const { data: inserted, error } = await db
        .from("customers")
        .insert({
          workspace_id: write.workspaceId,
          display_name: full,
          phone: data.phone ?? data.contact ?? "",
          phon_key: key,
          metadata: {
            first_name: first,
            last_name: last,
            dob: data.dob ?? "",
            zip: data.zip ?? "",
            insurance_company: data.insurance_company ?? "",
            member_id: data.member_id ?? "",
            plan_holder: data.plan_holder ?? "",
            patient_status: data.patient_status ?? "",
            time_preference: data.time_pref ?? "",
            captured_via: "voice",
          },
        })
        .select("id")
        .maybeSingle();
      if (error) console.error(`customer insert failed: ${error.message}`);
      else if (inserted) customerId = String((inserted as Record<string, unknown>).id);
    }
  }

  const { data: booking, error: bookErr } = await db
    .from("bookings")
    .insert({
      workspace_id: write.workspaceId,
      conversation_id: write.conversationId,
      customer_id: customerId,
      customer_name: full,
      contact: data.phone ?? data.contact ?? "",
      starts_at: write.startsAt,
      notes: write.notes,
      capture: { data, skipped: write.capture.skipped, summary: summarize(write.capture) },
      source: "agent",
    })
    .select("id")
    .maybeSingle();
  if (bookErr) console.error(`booking insert failed: ${bookErr.message}`);

  return {
    customerId,
    bookingId: booking ? String((booking as Record<string, unknown>).id) : null,
  };
}

export { emptyState };
