# Image Compression Service — optional container build reference
# Build context: repo root (parent of gcp/)
# Usage: docker build -f gcp/Dockerfile .

FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY gcp/package.json gcp/package-lock.json ./gcp/
RUN cd gcp && npm ci

# Copy gcp source
COPY gcp/tsconfig.json ./gcp/
COPY gcp/server.ts ./gcp/
COPY gcp/lib/ ./gcp/lib/
COPY gcp/routes/ ./gcp/routes/

RUN cd gcp && npm run build && npm prune --omit=dev

# --- Production image ---
FROM node:22-bookworm-slim

WORKDIR /app/gcp

COPY --from=builder /app/gcp/node_modules ./node_modules
COPY --from=builder /app/gcp/dist ./dist

ENV NODE_ENV=production
ENV PORT=8080

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:8080/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/gcp/server.js"]
