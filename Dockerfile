# --- build stage ---
FROM node:22-slim AS builder

WORKDIR /app

# pnpm asks for confirmation before wiping node_modules. There is no terminal
# in a Docker build, so it aborts instead. CI=true makes it non-interactive.
ENV CI=true

# corepack ships with Node and installs the exact pnpm version from
# package.json's "packageManager" field.
RUN corepack enable

# Lockfile FIRST, before source. Docker rebuilds a layer only when its inputs
# change, so editing a controller does not reinstall node_modules.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# --- runtime stage ---
FROM node:22-slim

WORKDIR /app

ENV CI=true

RUN corepack enable

# --prod skips devDependencies: no typescript, no nest CLI, no jest.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

# The .proto is NOT compiled. proto-loader reads it at runtime and
# auth.module.ts resolves it from process.cwd(), which is /app here.
COPY proto ./proto

RUN chown -R node:node /app
USER node

EXPOSE 3000

CMD ["node", "dist/main"]
