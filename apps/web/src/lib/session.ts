export interface Workspace {
  id: string;
  name: string;
  createdAt?: string;
  role?: string;
}

const LS_USER = "vas.userId";
const LS_WS = "vas.workspace";

export function getUserId(): string {
  let id = localStorage.getItem(LS_USER);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LS_USER, id);
  }
  return id;
}

export function getWorkspace(): Workspace | null {
  const raw = localStorage.getItem(LS_WS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Workspace;
  } catch {
    return null;
  }
}

export function setWorkspace(ws: Workspace): void {
  localStorage.setItem(LS_WS, JSON.stringify(ws));
}

export function clearWorkspace(): void {
  localStorage.removeItem(LS_WS);
}
