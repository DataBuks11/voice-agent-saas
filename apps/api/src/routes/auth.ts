import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { createUser, findUserByEmail, getUserById, verifyPassword } from "../lib/auth.js";
import { signJwt } from "../lib/jwt.js";

const registerSchema = z.object({
  email: z.string().email().max(160),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(80).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(160),
  password: z.string().min(1).max(200),
});

/**
 * Simple credential auth: POST /v1/auth/register and /v1/auth/login
 * return a bearer JWT. No OTP, no email verification, no Supabase Auth.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (req, reply) => {
    const body = registerSchema.parse((req as { body: unknown }).body);
    const db = getSupabase();
    const user = await createUser(db, body.email, body.password, body.name);
    const token = signJwt({ sub: user.id, email: user.email, name: user.display_name ?? undefined }, app.jwtSecret);
    return reply.status(201).send({ token, user });
  });

  app.post("/auth/login", async (req, reply) => {
    const body = loginSchema.parse((req as { body: unknown }).body);
    const db = getSupabase();
    const user = await findUserByEmail(db, body.email);
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      throw Object.assign(new Error("invalid email or password"), { status: 401 });
    }
    const token = signJwt({ sub: user.id, email: user.email, name: user.display_name ?? undefined }, app.jwtSecret);
    return reply.send({
      token,
      user: { id: user.id, email: user.email, display_name: user.display_name },
    });
  });

  app.get("/auth/me", async (req, reply) => {
    const headers = req.headers as Record<string, string | undefined>;
    const auth = headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const payload = token ? (await import("../lib/jwt.js")).verifyJwt(token, app.jwtSecret) : null;
    if (!payload) throw Object.assign(new Error("invalid or missing token"), { status: 401 });
    const db = getSupabase();
    const user = await getUserById(db, payload.sub);
    if (!user) throw Object.assign(new Error("invalid or missing token"), { status: 401 });
    return reply.send({ user });
  });
}
