FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    procps \
    tzdata \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    openbox \
    fonts-liberation \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci && npx playwright install --with-deps chromium

COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN npm run build:server && npm run build:web

ARG VESPERA_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/JhinxDev/vespera"
LABEL org.opencontainers.image.description="Self-hosted social media publishing workbench, direct video uploader, and AI/MCP creator studio"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.revision="${VESPERA_REVISION}"

ENV NODE_ENV=production
ENV VESPERA_DOCKER=1
ENV VESPERA_HOST=0.0.0.0
ENV VESPERA_PORT=4660
ENV VESPERA_DATA_DIR=/data
ENV VESPERA_REVISION="${VESPERA_REVISION}"

VOLUME ["/data"]
EXPOSE 4660

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD curl -fsS http://127.0.0.1:4660/api/health || exit 1

CMD ["node", "dist/server/cli.js", "serve"]
