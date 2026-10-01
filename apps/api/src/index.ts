import Fastify from "fastify";
import { loadConfig } from "@voice-agent/config";
import { createLogger } from "@voice-agent/shared";
import { healthRoutes } from "./routes/health.js";
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
  app.register(agentRoutes, { prefix: "/v1" });
  app.register(knowledgeRoutes, { prefix: "/v1" });
  app.register(conversationRoutes, { prefix: "/v1" });

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { status?: number }).status ?? 500;
    log.error("request failed", { message: (err as Error).message });
    reply.status(status).send({ error: (err as Error).message ?? "internal error" });
  });

  return { app, config, log };
}

const { app, config, log } = buildServer();
app.listen({ port: config.API_PORT, host: config.API_HOST }).then(() => {
  log.info(`API listening on ${config.API_HOST}:${config.API_PORT}`);
});
