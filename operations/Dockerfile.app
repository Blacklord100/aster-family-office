# syntax=docker/dockerfile:1
# Build context: app/. Review and pin the base digest for release.
ARG NODE_IMAGE=node:24-trixie-slim
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79
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
    && test -f dist-mailbox-worker/index.js && test -f dist-delivery-worker/index.js \
    && test -f dist-report-obligations-worker/index.js \
    && test -f dist-folder-worker/index.js && test -f dist-archive-worker/index.js \
    && test -f dist-ops/migrate.js && test -f dist-ops/bootstrap.js
RUN npm prune --omit=dev
RUN mkdir -p /runtime-dirs/aster-health /runtime-dirs/aster-intake /runtime-dirs/aster-archive

FROM ${NODE_RUNTIME_IMAGE} AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 PATH="/nodejs/bin:${PATH}"
WORKDIR /app
COPY --from=builder --chown=1000:1000 /app/.next/standalone ./.next/standalone
COPY --from=builder --chown=1000:1000 /app/.next/static ./.next/standalone/.next/static
COPY --from=builder --chown=1000:1000 /app/public ./.next/standalone/public
COPY --from=builder --chown=1000:1000 /app/dist-worker ./dist-worker
COPY --from=builder --chown=1000:1000 /app/dist-mailbox-worker ./dist-mailbox-worker
COPY --from=builder --chown=1000:1000 /app/dist-delivery-worker ./dist-delivery-worker
COPY --from=builder --chown=1000:1000 /app/dist-report-obligations-worker ./dist-report-obligations-worker
COPY --from=builder --chown=1000:1000 /app/dist-folder-worker ./dist-folder-worker
COPY --from=builder --chown=1000:1000 /app/dist-archive-worker ./dist-archive-worker
COPY --from=builder --chown=1000:1000 /app/dist-ops ./dist-ops
COPY --from=builder --chown=1000:1000 /app/migrations ./migrations
COPY --from=builder --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=builder --chown=1000:1000 /app/package.json ./package.json
# Optional demo corpus contains synthetic originals and routing metadata only.
# Financial benchmark answer keys are excluded from the build context and image.
COPY --from=builder --chown=1000:1000 /app/benchmark/mailroom-v1/catalog.json ./benchmark/mailroom-v1/catalog.json
COPY --from=builder --chown=1000:1000 /app/benchmark/mailroom-v1/fixtures/emails ./benchmark/mailroom-v1/fixtures/emails
COPY --from=builder --chown=1000:1000 /app/benchmark/history-v1/catalog.json ./benchmark/history-v1/catalog.json
COPY --from=builder --chown=1000:1000 /app/benchmark/history-v1/fixtures/emails ./benchmark/history-v1/fixtures/emails
# Operational scripts read SQL assets from /app/migrations.
COPY operations/scripts/app-entrypoint.mjs /opt/aster/app-entrypoint.mjs
COPY operations/scripts/bootstrap-stdin.mjs /opt/aster/bootstrap-stdin.mjs
COPY operations/scripts/worker-healthcheck.mjs /opt/aster/worker-healthcheck.mjs
COPY --from=builder --chown=1000:1000 /runtime-dirs/aster-health /run/aster-health
COPY --from=builder --chown=1000:1000 /runtime-dirs/aster-intake /run/aster-intake
COPY --from=builder --chown=1000:1000 /runtime-dirs/aster-archive /run/aster-archive
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["/nodejs/bin/node", "/opt/aster/app-entrypoint.mjs"]
CMD ["node", ".next/standalone/server.js"]
