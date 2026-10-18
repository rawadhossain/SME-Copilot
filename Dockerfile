# Offline demo image. Bun is used ONLY to install, to build, and to run the one-off setup scripts (migrate, seed); Next.js itself runs under Node.
FROM node:20-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS app
COPY . .
# The build needs no database; this placeholder only satisfies the module that reads the variable at import time (never used to connect).
ENV APP_DATABASE_URL=postgres://build:build@localhost:5432/build
RUN bun run build
ENV APP_DATABASE_URL=
EXPOSE 3000
ENTRYPOINT ["sh", "docker/entrypoint.sh"]
