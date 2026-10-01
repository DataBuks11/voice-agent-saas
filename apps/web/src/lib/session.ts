export interface Workspace {
  id: string;
  name: string;
  createdAt?: string;
  role?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  display_name?: string | null;
}

const LS_TOKEN = "vas.token";
const LS_USER = "vas.user";
const LS_WS = "vas.workspace";

export function getToken(): string | null {
  return localStorage.getItem(LS_TOKEN);
}

export function setSession(token: string, user: AuthUser): void {
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_USER, JSON.stringify(user));
}

export function getUser(): AuthUser | null {
  const raw = localStorage.getItem(LS_USER);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USER);
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
