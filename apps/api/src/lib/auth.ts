import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ensure the caller exists in auth.users.
 * Demo/local identities are provisioned as confirmed auth users so FKs
 * (memberships.user_id, profiles.id -> auth.users.id) hold. Supabase Auth
 * signup UI replaces this in milestone 3 — real users pass through untouched.
 */
export async function ensureAuthUser(db: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (data?.user) return;

  const { error: createErr } = await db.auth.admin.createUser({
    id: userId,
    email: `${userId}@demo.local`,
    password: `vp-${userId.slice(0, 8)}-${Date.now().toString(36)}`,
    email_confirm: true,
  });
  if (createErr && !/already|exists/i.test(createErr.message)) {
    throw Object.assign(new Error(`auth user provision failed: ${createErr.message}`), { status: 500 });
  }
}
