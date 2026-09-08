# syntax=docker/dockerfile:1
# Build context: app/. Review and pin the base digest for release.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY . ./
# No real secrets or database access at build time.
RUN npm run build
RUN test -f .next/standalone/server.js && test -f dist-worker/index.js \
    && test -f dist-mailbox-worker/index.js \
    && test -f dist-ops/migrate.js && test -f dist-ops/bootstrap.js
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=builder --chown=node:node /app/.next/standalone ./.next/standalone
COPY --from=builder --chown=node:node /app/.next/static ./.next/standalone/.next/static
COPY --from=builder --chown=node:node /app/public ./.next/standalone/public
COPY --from=builder --chown=node:node /app/dist-worker ./dist-worker
COPY --from=builder --chown=node:node /app/dist-mailbox-worker ./dist-mailbox-worker
COPY --from=builder --chown=node:node /app/dist-ops ./dist-ops
COPY --from=builder --chown=node:node /app/migrations ./migrations
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
# Operational scripts read SQL assets from /app/migrations.
COPY operations/scripts/app-entrypoint.mjs /opt/aster/app-entrypoint.mjs
COPY operations/scripts/worker-healthcheck.mjs /opt/aster/worker-healthcheck.mjs
USER node
EXPOSE 3000
ENTRYPOINT ["node", "/opt/aster/app-entrypoint.mjs"]
CMD ["node", ".next/standalone/server.js"]
