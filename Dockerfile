# syntax=docker/dockerfile:1
FROM node:24.11.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --cache /tmp/npm-cache
COPY . .
RUN npm run build \
    && npm prune --omit=dev --cache /tmp/npm-cache \
    && mkdir -p /runtime/scripts /runtime/data /runtime/backups \
    && cp -r node_modules dist server package.json /runtime/ \
    && cp scripts/backup.mjs /runtime/scripts/

FROM node:24.11.1-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/app/data/vpr.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
