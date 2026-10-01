import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/** Server-side Supabase client (service-role when available, else anon). Never expose service key to frontend. */
export function getSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / key missing. Copy .env.example to .env first.");
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
