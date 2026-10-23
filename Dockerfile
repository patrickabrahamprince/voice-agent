# Multi-stage Docker build for Voice AI Production (Debian glibc for native better-sqlite3 stability)
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native build
RUN apt-get update && apt-get install -y python3 make g++ gcc && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN npm run build

# Production Runtime Stage
FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Runtime build tools for native addons
RUN apt-get update && apt-get install -y python3 make g++ gcc && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/dashboard ./src/dashboard
COPY --from=builder /app/public ./public
RUN mkdir -p data
COPY data/seed_data.json ./data/

EXPOSE 3001

CMD ["node", "dist/server.js"]
