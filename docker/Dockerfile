# Multi-stage build for the whole monorepo.
#
# Four targets:
#   deps     — installed node_modules, cached independently of source changes
#   runtime  — deps + source + generated Prisma client (used by `migrate`)
#   web      — runtime + a production Next build
#   worker   — runtime, running the background process
#
# The web and worker images deliberately share the `runtime` layer rather than
# being built independently: they import the same five workspace packages, so
# splitting them would duplicate ~90% of the image for no isolation benefit.

# ─── deps ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# openssl is required by Prisma's query engine at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy only the manifests first, so `npm ci` is cached until a dependency
# actually changes. Every workspace manifest is needed for the install to
# resolve the local `*` links.
COPY package.json package-lock.json ./
COPY packages/core/package.json      packages/core/
COPY packages/platform/package.json  packages/platform/
COPY packages/db/package.json        packages/db/
COPY packages/connectors/package.json packages/connectors/
COPY packages/ai/package.json        packages/ai/
COPY packages/worker/package.json    packages/worker/
COPY apps/web/package.json           apps/web/

# `--ignore-scripts` stops Prisma's postinstall from running before the schema
# is present; the client is generated explicitly in the next stage.
RUN npm ci --ignore-scripts --no-audit --no-fund

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate the Prisma client into node_modules. Done here so both app targets
# inherit it and neither has to run a build step to talk to the database.
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

# ─── web ─────────────────────────────────────────────────────────────────────
FROM runtime AS web
WORKDIR /app

# A build-time DATABASE_URL is required because `next build` evaluates route
# modules, which construct the Prisma client. It is never connected to — the real
# URL arrives via the environment at run time.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build?schema=public
ENV REDIS_URL=redis://localhost:6379
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build -w apps/web

# Drop to a non-root user for the long-running process.
USER node
EXPOSE 3000
ENV PORT=3000
CMD ["npm", "run", "start", "-w", "apps/web"]

# ─── worker ──────────────────────────────────────────────────────────────────
FROM runtime AS worker
WORKDIR /app
USER node
# tsx runs the TypeScript entrypoint directly. The worker has no bundling step:
# it is a long-lived process where start-up time is irrelevant, and running the
# real source keeps stack traces pointing at files a developer can open.
CMD ["npm", "run", "start", "-w", "@cid/worker"]
