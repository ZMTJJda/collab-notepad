# ---- Stage 1: Install dependencies ----
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: Production image ----
FROM node:20-alpine AS runner

LABEL maintainer="Collab Notepad"
LABEL description="LAN real-time collaborative notepad with file sharing"

# Security: run as non-root
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY src/ ./src/
COPY convert-worker.js ./
COPY public/ ./public/

# Data directory (will be mounted as volume)
RUN mkdir -p /app/data && chown -R appuser:appgroup /app/data

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8000/api/health || exit 1

# Default environment
ENV NODE_ENV=production \
    PORT=8000 \
    DATA_DIR=/app/data

# Start
CMD ["node", "src/server.js"]
