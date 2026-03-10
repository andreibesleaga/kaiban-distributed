# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src/ ./src/
COPY examples/ ./examples/

RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine AS runner

WORKDIR /app

# Non-root user for security (SOC2/ISO 27001)
RUN addgroup -S kaiban && adduser -S kaiban -G kaiban

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

USER kaiban

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/src/main/index.js"]
