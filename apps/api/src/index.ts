import Fastify from "fastify";
import { ZodError } from "zod";
import { loadConfig } from "@voice-agent/config";
import { createLogger } from "@voice-agent/shared";
import { healthRoutes } from "./routes/health.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { agentRoutes } from "./routes/agents.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { conversationRoutes } from "./routes/conversations.js";

export function buildServer() {
  const config = loadConfig();
  const log = createLogger("api", config.LOG_LEVEL);
  const app = Fastify({ logger: false });

  app.addHook("onRequest", (req, _reply, done) => {
    log.info(`${req.method} ${req.url}`);
    done();
  });

  app.register(healthRoutes);
  app.register(workspaceRoutes, { prefix: "/v1" });
  app.register(agentRoutes, { prefix: "/v1" });
  app.register(knowledgeRoutes, { prefix: "/v1" });
  app.register(conversationRoutes, { prefix: "/v1" });

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
// Hosting platforms (Render/Railway) inject PORT — respect it over API_PORT.
const port = Number(process.env.PORT ?? config.API_PORT);
app.listen({ port, host: config.API_HOST }).then(() => {
  log.info(`API listening on ${config.API_HOST}:${port}`);
});
