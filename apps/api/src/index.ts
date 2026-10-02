import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { loadConfig } from "@voice-agent/config";
import { createLogger } from "@voice-agent/shared";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { agentRoutes } from "./routes/agents.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { conversationRoutes } from "./routes/conversations.js";
import { bookingRoutes } from "./routes/bookings.js";
import { warmupEmbeddings } from "./lib/embeddings.js";
import { runMigrations } from "./lib/migrate.js";

declare module "fastify" {
  interface FastifyInstance {
    jwtSecret: string;
    stats: { served: number; blocked: number; startedAt: string };
  }
}

export function buildServer() {
  const config = loadConfig();
  const log = createLogger("api", config.LOG_LEVEL);
  // Raised body limit: document uploads (pdf/docx base64) ride on JSON requests.
  const app = Fastify({ logger: false, bodyLimit: Number(process.env.BODY_LIMIT ?? 48 * 1024 * 1024) });

  app.decorate("jwtSecret", config.JWT_SECRET);
  app.decorate("stats", { served: 0, blocked: 0, startedAt: new Date().toISOString() });

  const allowedOrigins = (
    process.env.CORS_ORIGINS ?? "https://voice-agent-saas-web.vercel.app,http://localhost:5173,http://localhost:3001"
  )
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) cb(null, true);
      else cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-workspace-id", "x-admin-token", "x-service-key"],
  });

  app.addHook("onRequest", (req, _reply, done) => {
    log.info(`${req.method} ${req.url}`);
    done();
  });

  // Sliding-window rate limiter (dependency-free): 600 req/min per IP globally,
  // 30/min on auth+admin to slow credential stuffing. RATE_LIMIT_DISABLED=1 for tests.
  const windowMs = 60_000;
  const globalMax = Number(process.env.RATE_LIMIT_MAX ?? 600);
  const authMax = Number(process.env.RATE_LIMIT_AUTH_MAX ?? 30);
  const buckets = new Map<string, { n: number; start: number }>();
  if (process.env.RATE_LIMIT_DISABLED !== "1") {
    app.addHook("onRequest", (req, reply, done) => {
      app.stats.served += 1;
      const url = req.url.split("?")[0] ?? "";
      const strict = url.startsWith("/v1/auth/") || url.startsWith("/v1/admin/");
      if (!strict && (url === "/health" || url.startsWith("/v1/health"))) return done();
      const key = `${strict ? "auth" : "ip"}:${req.ip}`;
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || now - b.start >= windowMs) {
        if (buckets.size > 5_000) {
          for (const [k, v] of buckets) if (now - v.start >= windowMs) buckets.delete(k);
        }
        b = { n: 0, start: now };
        buckets.set(key, b);
      }
      b.n += 1;
      if (b.n > (strict ? authMax : globalMax)) {
        app.stats.blocked += 1;
        reply
          .status(429)
          .header("retry-after", String(Math.max(1, Math.ceil((b.start + windowMs - now) / 1000))))
          .send({ error: "rate limit exceeded" });
        return;
      }
      done();
    });
  }

  app.register(healthRoutes);
  app.register(authRoutes, { prefix: "/v1" });
  app.register(adminRoutes, { prefix: "/v1" });
  app.register(workspaceRoutes, { prefix: "/v1" });
  app.register(agentRoutes, { prefix: "/v1" });
  app.register(knowledgeRoutes, { prefix: "/v1" });
  app.register(conversationRoutes, { prefix: "/v1" });
  app.register(bookingRoutes, { prefix: "/v1" });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.status(400).send({ error: "validation failed", issues: err.issues });
      return;
    }
    const status = (err as { status?: number }).status ?? 500;
    log.error("request failed", { message: (err as Error).message });
    reply.status(status).send({ error: (err as Error).message ?? "internal error" });
  });

  return { app, config, log };
}

const { app, config, log } = buildServer();

// Apply pending SQL migrations at boot (idempotent; baselines 0001/0002).
// Never crash the API over schema sync — surface loudly instead.
runMigrations(process.env.DATABASE_URL ?? "")
  .then((r) => {
    if (r.applied.length) log.info(`migrations applied: ${r.applied.join(", ")}`);
  })
  .catch((e) => log.error(`migration run failed: ${e.message}`));

// Decide embeddings provider early (downloads the local semantic model at boot).
warmupEmbeddings();

// Hosting platforms (Render/Railway) inject PORT — respect it over API_PORT.
const port = Number(process.env.PORT ?? config.API_PORT);
app.listen({ port, host: config.API_HOST }).then(() => {
  log.info(`API listening on ${config.API_HOST}:${port}`);
});
