import type { FastifyRequest } from "fastify";
import { getSupabase } from "./supabase.js";

export interface TenantContext {
  userId: string;
  workspaceId: string;
}

/**
 * Resolve tenant from the Authorization bearer JWT + workspace header:
 *   Authorization: Bearer <jwt>  - authenticated user (simple credential auth)
 *   x-workspace-id               - active workspace
 * Membership is verified against the memberships table, so RLS-equivalent
 * checks apply even though the server uses the service role.
 */
export async function requireTenant(req: FastifyRequest): Promise<TenantContext> {
  const headers = req.headers as Record<string, string | undefined>;
  const workspaceId = headers["x-workspace-id"];
  const userId = await requireUserId(req);
  if (!workspaceId) throw Object.assign(new Error("x-workspace-id header required"), { status: 400 });
  return verifyMembership(userId, workspaceId);
}

/** Extract user id from `Authorization: Bearer <jwt>` (401 when missing/invalid). */
export async function requireUserId(req: FastifyRequest): Promise<string> {
  const headers = req.headers as Record<string, string | undefined>;
  const auth = headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw Object.assign(new Error("Authorization bearer token required"), { status: 401 });
  const { verifyJwt } = await import("./jwt.js");
  const { loadConfig } = await import("@voice-agent/config");
  const payload = verifyJwt(token, loadConfig().JWT_SECRET);
  if (!payload) throw Object.assign(new Error("invalid or expired token"), { status: 401 });
  return payload.sub;
}

export async function verifyMembership(userId: string, workspaceId: string | undefined): Promise<TenantContext> {
  if (!workspaceId) throw Object.assign(new Error("x-workspace-id header required"), { status: 400 });
  const db = getSupabase();
  const { data, error } = await db
    .from("memberships")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw Object.assign(new Error("membership check failed"), { status: 500 });
  if (!data) throw Object.assign(new Error("not a member of workspace"), { status: 403 });
  return { userId, workspaceId };
}

/** Resolve workspace from `x-workspace-id` header + verify caller membership. */
export async function requireWorkspace(userId: string, workspaceId: string | undefined): Promise<string> {
  return (await verifyMembership(userId, workspaceId)).workspaceId;
}
