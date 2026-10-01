import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Simple credential authentication: email + password, no Supabase Auth,
 * no OTP, no email verification. Passwords are scrypt-hashed and stored
 * in public.app_users (migration 0003); the API issues its own JWTs.
 */

const SCRYPT_N = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N }).toString("hex");
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, nStr, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length, { N: Number(nStr) || SCRYPT_N });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface AppUser {
  id: string;
  email: string;
  display_name: string | null;
}

export async function findUserByEmail(db: SupabaseClient, email: string): Promise<(AppUser & { password_hash: string }) | null> {
  const { data, error } = await db
    .from("app_users")
    .select("id, email, display_name, password_hash")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  if (error) throw Object.assign(new Error(`user lookup failed: ${error.message}`), { status: 500 });
  return (data as (AppUser & { password_hash: string }) | null) ?? null;
}

export async function createUser(db: SupabaseClient, email: string, password: string, name?: string): Promise<AppUser> {
  const { data, error } = await db
    .from("app_users")
    .insert({ email: email.toLowerCase(), password_hash: hashPassword(password), display_name: name ?? null })
    .select("id, email, display_name")
    .single();
  if (error) {
    const status = error.code === "23505" ? 409 : 500;
    throw Object.assign(new Error(error.code === "23505" ? "email already registered" : `user create failed: ${error.message}`), { status });
  }
  return data as AppUser;
}

export async function getUserById(db: SupabaseClient, id: string): Promise<AppUser | null> {
  const { data, error } = await db.from("app_users").select("id, email, display_name").eq("id", id).maybeSingle();
  if (error) throw Object.assign(new Error(`user lookup failed: ${error.message}`), { status: 500 });
  return (data as AppUser | null) ?? null;
}
