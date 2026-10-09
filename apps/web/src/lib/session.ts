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

export const DEFAULT_WORKSPACE: Workspace = {
  id: "14a6e54a-a071-4756-92a5-24600e630d1a",
  name: "DataBuks Dental AI",
  role: "owner",
};

export const DEFAULT_USER: AuthUser = {
  id: "ce329a05-b139-43c0-a54f-b3950a212139",
  email: "guest@dentalcare.com",
  display_name: "Dental Practice Guest",
};

export const DEFAULT_TOKEN = "demo-token";

export function getToken(): string {
  const token = localStorage.getItem(LS_TOKEN);
  if (token) return token;
  localStorage.setItem(LS_TOKEN, DEFAULT_TOKEN);
  return DEFAULT_TOKEN;
}

export function setSession(token: string, user: AuthUser): void {
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_USER, JSON.stringify(user));
}

export function getUser(): AuthUser {
  const raw = localStorage.getItem(LS_USER);
  if (raw) {
    try {
      return JSON.parse(raw) as AuthUser;
    } catch {}
  }
  localStorage.setItem(LS_USER, JSON.stringify(DEFAULT_USER));
  return DEFAULT_USER;
}

export function clearSession(): void {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USER);
}

export function getWorkspace(): Workspace {
  const raw = localStorage.getItem(LS_WS);
  if (raw) {
    try {
      return JSON.parse(raw) as Workspace;
    } catch {}
  }
  localStorage.setItem(LS_WS, JSON.stringify(DEFAULT_WORKSPACE));
  return DEFAULT_WORKSPACE;
}

export function setWorkspace(ws: Workspace): void {
  localStorage.setItem(LS_WS, JSON.stringify(ws));
}

export function clearWorkspace(): void {
  localStorage.removeItem(LS_WS);
}
