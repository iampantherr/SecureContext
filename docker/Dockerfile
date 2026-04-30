# SecureContext API Server
# Multi-stage build: compile TypeScript → minimal runtime image
#
# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts

# Copy source
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --omit=dev


# Stage 2: Runtime
FROM node:22-alpine AS runtime

# Security: run as non-root user
RUN addgroup -g 1001 -S securecontext && \
    adduser  -u 1001 -S securecontext -G securecontext

WORKDIR /app

# Copy built artifacts + production deps only
COPY --from=builder --chown=securecontext:securecontext /app/dist        ./dist
COPY --from=builder --chown=securecontext:securecontext /app/node_modules ./node_modules
COPY --from=builder --chown=securecontext:securecontext /app/package.json ./package.json

# v0.20.0 — bake the skills/ directory into the image so the auto-importer
# has something to scan on first boot. Operators can also volume-mount their
# host skills/ over this in docker-compose for live editing.
COPY --chown=securecontext:securecontext skills/ ./skills/

USER securecontext

# Health check — uses the /health endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3099/health || exit 1

EXPOSE 3099

# Start the API server directly (not the MCP plugin)
CMD ["node", "dist/api-server.js"]
