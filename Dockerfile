# --- build stage ---
FROM node:22-slim AS builder
WORKDIR /app

# pnpm asks for confirmation before wiping node_modules. There is no terminal
# in a Docker build, so it aborts instead. CI=true makes it non-interactive.
ENV CI=true

# Prisma 7 talks to Postgres through the pg driver adapter, which needs openssl.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Lockfile FIRST, before source. Docker rebuilds a layer only when its inputs
# change, so editing a controller does not reinstall node_modules.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Schema before source, same reasoning: the generated client only changes
# when the schema does, not when a handler does.
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node prisma.config.ts ./
RUN npx prisma generate

COPY . .
# Belt and braces. .dockerignore should keep the host cache out, but a
# stale .tsbuildinfo makes tsc skip emitting entirely and the failure is
# silent: the build "succeeds" and produces an image with no .js in it.
RUN rm -rf dist *.tsbuildinfo && pnpm build && test -f dist/main.js

# --- runtime stage ---
FROM node:22-slim
WORKDIR /app
ENV CI=true
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# --prod skips devDependencies: no typescript, no nest CLI, no vitest.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# The Prisma CLI is a devDependency, so --prod just removed it. Add it back
# alone: the migrate job runs `prisma migrate deploy` from this same image,
# and shipping one CLI beats shipping the whole dev toolchain.
# Install the CLI WITHOUT touching package.json.
# `pnpm add` rewrites the manifest, and a rewritten manifest can change
# how Node resolves module format, which breaks the generated Prisma
# client (CommonJS) by loading it as ESM.
# The Prisma CLI is a regular dependency, not a dev one, so the --prod
# install above already includes it. The migrate job runs
# `prisma migrate deploy` from this same image.

COPY --from=builder --chown=node:node /app/dist ./dist

# Migrations travel with the image, so the migrate job and the API are always
# the same version. A container running migrations it was not built against
# is how schemas drift.
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node prisma.config.ts ./

# The .proto is NOT compiled. proto-loader reads it at runtime and
# auth.module.ts resolves it from process.cwd(), which is /app here.
COPY --chown=node:node proto ./proto

USER node

ENV PORT=3851
EXPOSE 3851

CMD ["node", "dist/main.js"]
