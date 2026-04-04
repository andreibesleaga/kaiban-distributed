# Stage 1: Build
# Pin to the Node 22 LTS minor release for reproducible builds.
# Update this tag when you upgrade Node (also update the runner stage below).
FROM node:22.14-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install --include=dev

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY examples/ ./examples/

# tsconfig.build.json excludes tests/ — only src/ and examples/ are compiled
RUN npm run build

# Stage 2: Runtime
# Same base as builder to guarantee ABI compatibility.
FROM node:22.14-alpine AS runner

WORKDIR /app

# Non-root user for security (SOC2/ISO 27001)
RUN addgroup -S kaiban && adduser -S kaiban -G kaiban

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

USER kaiban

# Allow the health-check port to be overridden at build time: --build-arg PORT=8080
ARG PORT=3000
ENV PORT=${PORT}

EXPOSE ${PORT}

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "dist/src/main/index.js"]
