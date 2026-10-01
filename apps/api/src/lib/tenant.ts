import type { FastifyRequest } from "fastify";
import { getSupabase } from "./supabase.js";

export interface TenantContext {
  userId: string;
  workspaceId: string;
}

/**
 * Resolve tenant from headers:
 *   x-user-id       - authenticated user (Supabase Auth JWT lands here in m3; demo uses local uuid)
 *   x-workspace-id  - active workspace
 * Membership is verified against the memberships table, so RLS-equivalent
 * checks apply even though the server uses the service role.
 */
export async function requireTenant(req: FastifyRequest): Promise<TenantContext> {
  const headers = req.headers as Record<string, string | undefined>;
  const userId = headers["x-user-id"];
  const workspaceId = headers["x-workspace-id"];
  if (!userId) throw Object.assign(new Error("x-user-id header required"), { status: 400 });
  if (!workspaceId) throw Object.assign(new Error("x-workspace-id header required"), { status: 400 });
  return verifyMembership(userId, workspaceId);
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
