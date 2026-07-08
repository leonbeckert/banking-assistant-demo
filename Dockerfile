# Retail-assistant demo — container image for the deployed backup.
# Multi-stage: install → build (Next standalone) → slim runtime.
# The app is a single long-running Node process (in-memory session store), so it
# must run as ONE instance — never scaled out. Lightsail scale=1 satisfies this.

# ---- deps ------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build -----------------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* is inlined at BUILD time, so the brand must be set here (not just
# at runtime). Defaults to a neutral name; override with --build-arg to set a specific brand.
ARG NEXT_PUBLIC_BRAND_NAME="Retail Bank"
ENV NEXT_PUBLIC_BRAND_NAME=$NEXT_PUBLIC_BRAND_NAME
RUN npm run build

# ---- runtime ---------------------------------------------------------------
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Standalone server + static assets.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Files read at runtime via fs.readFileSync — NOT traced by `output: standalone`,
# so they must be copied in explicitly, or the routes that read them degrade to
# "not run yet" (retrieval corpus/index are load-bearing; the eval artifacts feed
# the scorecard/boundaries pages, which already null-guard a missing file).
COPY --from=builder /app/data ./data
COPY --from=builder /app/evals/results ./evals/results
EXPOSE 3000
# MISTRAL_API_KEY is injected at deploy time (Lightsail env), never baked in.
CMD ["node", "server.js"]
