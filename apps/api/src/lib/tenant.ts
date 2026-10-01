import { getSupabase } from "./supabase.js";

/** Resolve workspace from `x-workspace-id` header + verify caller membership. */
export async function requireWorkspace(userId: string, workspaceId: string | undefined): Promise<string> {
  if (!workspaceId) throw Object.assign(new Error("x-workspace-id header required"), { status: 400 });
  const db = getSupabase();
  const { data, error } = await db.from("memberships").select("workspace_id").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  if (error) throw Object.assign(new Error("membership check failed"), { status: 500 });
  if (!data) throw Object.assign(new Error("not a member of workspace"), { status: 403 });
  return workspaceId;
}
