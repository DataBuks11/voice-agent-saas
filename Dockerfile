FROM node:22-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY engines ./engines
COPY apps/api ./apps/api
RUN pnpm install --filter @voice-agent/api --no-frozen-lockfile
EXPOSE 3001
CMD ["pnpm", "--filter", "@voice-agent/api", "start"]
