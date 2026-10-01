import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtPayload {
  sub: string;
  email: string;
  name?: string | undefined;
  iat: number;
  exp: number;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signJwt(payload: Omit<JwtPayload, "iat" | "exp">, secret: string, ttlSeconds = 7 * 24 * 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const full: JwtPayload = { ...payload, iat: now, exp: now + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(full));
  const sig = hmac(`${header}.${body}`, secret);
  return `${header}.${body}.${sig}`;
}

/** Verify signature + expiry. Returns null for anything invalid. */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header = "", body = "", sig = ""] = parts;
  const expected = hmac(`${header}.${body}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as JwtPayload;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
