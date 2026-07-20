# Tessera API.
#
# Multi-stage on purpose: the build stage needs the whole toolchain - compilers,
# dev dependencies, source - and none of that belongs in the image that runs in
# production. Shipping it would mean a larger image, a slower pull, and a much
# bigger surface for anything that gets into the container to work with.

# ---------------------------------------------------------------- builder ---
FROM node:22-alpine AS builder

WORKDIR /app

# Manifests first, source second. Docker caches each layer, so as long as the
# dependency files have not changed the (slow) install is reused and only the
# (fast) compile re-runs. Copying everything at once would invalidate the
# install cache on every source edit.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/

RUN npm ci --ignore-scripts

COPY packages/core ./packages/core
COPY packages/server ./packages/server

RUN npm run db:generate -w @tessera/server \
 && npm run build -w @tessera/core \
 && npm run build -w @tessera/server

# Drop dev dependencies before they are copied forward.
RUN npm prune --omit=dev

# ---------------------------------------------------------------- runtime ---
FROM node:22-alpine AS runtime

# Needed by the healthcheck below; the base image has no curl or wget.
RUN apk add --no-cache wget

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/server/prisma ./packages/server/prisma

# Run as a non-root user. The node image ships one already; root inside a
# container is still root if anything escapes, and nothing here needs it.
USER node

EXPOSE 4000

# Reports the container unhealthy when the API cannot reach its database, so an
# orchestrator restarts or reroutes instead of sending traffic into a black hole.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:4000/api/health || exit 1

CMD ["node", "packages/server/dist/main.js"]
