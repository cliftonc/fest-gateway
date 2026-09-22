# Fest, as one image.
#
# Two stages. The first installs everything and emits `web/dist`; none of that
# toolchain is copied forward, because Vite, React and TypeScript exist only to
# build the dashboard. Node runs the server's TypeScript directly by stripping
# types, so there is no compile step for it and no build output to carry.
#
# The runtime stage is this repository's own source plus the two dependencies
# that are genuinely needed at run time — `arctic` (the OAuth flows in
# server/auth and server/api) and `open` (reached from cli/login.ts, which
# server/bin/fest.ts imports statically). `--omit=dev` is what keeps the rest
# out.
#
# No credential is ever copied in. `.env` is excluded by .dockerignore and
# injected at run time by compose's `env_file`, so it stays out of the image
# layers — a secret baked into a layer is readable by anyone who can pull it.

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

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY shared ./shared
# cli/ is not optional here: server/bin/fest.ts imports it at the top level, so
# without it every command in this image fails to resolve, not just the
# developer ones.
COPY cli ./cli
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
