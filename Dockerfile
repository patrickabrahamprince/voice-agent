# Multi-stage Docker build for Voice AI Production
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 native build
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN npm run build

# Production Runtime Stage
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Runtime dependencies
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/dashboard ./src/dashboard
COPY --from=builder /app/public ./public
COPY data ./data

EXPOSE 3001

CMD ["node", "dist/server.js"]
