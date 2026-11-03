# Build from the repo root: docker build -f apps/server/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @si-bot/server...
COPY packages/shared packages/shared
COPY apps/server apps/server
WORKDIR /app/apps/server
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["pnpm", "start"]
