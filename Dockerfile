# ============================================================
# Stage 1: Build the Next.js application
# ============================================================
FROM node:20-alpine AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Install dependencies (cached unless the lockfile changes)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy source, test and build
COPY . .
RUN npx vitest run && npm run build && npm prune --omit=dev


# ============================================================
# Stage 2: Production runtime
# ============================================================
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget xz-utils ca-certificates openssh-client procps nginx \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

# s6-overlay for multi-process supervision
ARG S6_OVERLAY_VERSION=3.1.6.2
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz && \
    rm -f /tmp/s6-overlay-*.tar.xz

# rqlite
ARG RQLITE_VERSION=8.26.7
ADD https://github.com/rqlite/rqlite/releases/download/v${RQLITE_VERSION}/rqlite-v${RQLITE_VERSION}-linux-amd64.tar.gz /tmp
RUN tar -C /tmp -xzf /tmp/rqlite-v${RQLITE_VERSION}-linux-amd64.tar.gz && \
    mv /tmp/rqlite-v${RQLITE_VERSION}-linux-amd64/rqlited /usr/local/bin/ && \
    mv /tmp/rqlite-v${RQLITE_VERSION}-linux-amd64/rqlite /usr/local/bin/ && \
    rm -rf /tmp/rqlite-*

RUN mkdir -p /data/rqlite && chown -R node:node /data

WORKDIR /app

# Built application. poller.js and ws-server.js load the shared collectors
# from src/lib/collect at runtime.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/ws-server.js ./ws-server.js
COPY --from=builder /app/poller.js ./poller.js
COPY --from=builder /app/src/lib/collect ./src/lib/collect
COPY --from=builder /app/src/lib/secrets.js ./src/lib/secrets.js
# API terminal (ws-server.js): session handler, pure helpers and the shell-account checks.
COPY --from=builder /app/src/lib/terminal ./src/lib/terminal
COPY --from=builder /app/src/lib/ssh/shell-account.js /app/src/lib/ssh/windows-shell-account.js ./src/lib/ssh/
# Package widget data shaping and host script running, shared by the web app and the poller.
COPY --from=builder /app/src/lib/widgets/runtime/data.js /app/src/lib/widgets/runtime/script-run.js ./src/lib/widgets/runtime/
# Widget packages installed by default (see widgets/bundled.json).
COPY --from=builder /app/widgets ./widgets
# Cluster settings + the start-time helper used by the rqlite service.
COPY --from=builder /app/src/lib/cluster/config.js /app/src/lib/cluster/boot.js ./src/lib/cluster/
# Next writes its cache under .next at runtime; services run as `node`.
RUN chown -R node:node /app/.next

# s6 service definitions (normalise line endings / shebangs, make executable)
COPY s6-overlay/ /etc/s6-overlay/
RUN sed -i 's/\r$//' /etc/s6-overlay/s6-rc.d/*/run && \
    sed -i 's|#!/usr/bin/with-contenv|#!/command/with-contenv|g' /etc/s6-overlay/s6-rc.d/*/run && \
    chmod +x /etc/s6-overlay/s6-rc.d/*/run
COPY nginx/nginx.conf /etc/nginx/nginx.conf

COPY scripts/ /app/scripts/
RUN sed -i 's/\r$//' /app/scripts/*.sh && chmod +x /app/scripts/*.sh

ENV NODE_ENV=production \
    PORT=3000 \
    RQLITE_HTTP_PORT=4001 \
    RQLITE_RAFT_PORT=4002 \
    RQLITE_DATA_DIR=/data/rqlite \
    NEXT_TELEMETRY_DISABLED=1 \
    S6_KILL_GRACETIME=10000

EXPOSE 3042 4001 4002

VOLUME ["/data/rqlite"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/init"]
