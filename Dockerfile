# Fest, as one image.
#
# Two stages, and the second one is deliberately almost empty: Fest has NO
# runtime dependencies. `package.json` lists devDependencies only — Node 24 runs
# the TypeScript server directly by stripping types, and Vite and React exist
# solely to build the dashboard bundle. So the build stage installs them, emits
# `web/dist`, and none of it is copied forward. The runtime image is Node plus
# this repository's own source.

FROM node:24-alpine AS build
WORKDIR /app
# Dependencies before source, so an edit to a .ts file does not re-run npm ci.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build


FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY --from=build /app/web/dist ./web/dist

# The database and the JSONL trail live on a volume. Created and owned before
# dropping privileges, because the process will not be root and SQLite needs to
# write the -wal and -shm siblings next to the database file.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]

ENV FEST_DB=/data/fest.db \
    FEST_USAGE_LOG=/data/usage.jsonl \
    FEST_PORT=8787 \
    # A container is unreachable on loopback. That makes an owner account
    # mandatory: Fest refuses to serve an unauthenticated dashboard off
    # loopback, so the first run is
    #   docker compose run --rm fest admin create you@corp.test
    FEST_HOST=0.0.0.0

EXPOSE 8787

# /healthz, not the dashboard: it is the endpoint that answers without touching
# the database or requiring a session.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FEST_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ENTRYPOINT is the CLI, so `docker compose run --rm fest admin create …` and
# `… token create …` work without repeating the interpreter.
ENTRYPOINT ["node", "server/bin/fest.ts"]
CMD ["serve"]
