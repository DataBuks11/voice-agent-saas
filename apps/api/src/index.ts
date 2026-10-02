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
  }
}

export function buildServer() {
  const config = loadConfig();
  const log = createLogger("api", config.LOG_LEVEL);
  // Raised body limit: document uploads (pdf/docx base64) ride on JSON requests.
  const app = Fastify({ logger: false, bodyLimit: Number(process.env.BODY_LIMIT ?? 48 * 1024 * 1024) });

  app.decorate("jwtSecret", config.JWT_SECRET);

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
