# ============================================================
# Stage 1: Build the Next.js application
# ============================================================
FROM node:20-alpine AS builder


WORKDIR /app


# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci


# Copy source and build
COPY . .
RUN npm run build


# ============================================================
# Stage 2: Production runtime
# ============================================================
FROM node:20-alpine AS runtime


# Install s6-overlay for multi-process supervision
ARG S6_OVERLAY_VERSION=3.1.6.2
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz && \
    rm -f /tmp/s6-overlay-*.tar.xz


# Install rqlite binary
ARG RQLITE_VERSION=8.26.7
ADD https://github.com/rqlite/rqlite/releases/download/v${RQLITE_VERSION}/rqlite-v${RQLITE_VERSION}-linux-amd64.tar.gz /tmp
RUN tar -C /tmp -xzf /tmp/rqlite-v${RQLITE_VERSION}-linux-amd64.tar.gz && \
    mv /tmp/rqlite-v${RQLITE_VERSION}-linux-amd64/rqlited /usr/local/bin/ && \
    mv /tmp/rqlite-v${RQLITE_VERSION}-linux-amd64/rqlite /usr/local/bin/ && \
    rm -rf /tmp/rqlite-*


# Create data directory
RUN mkdir -p /data/rqlite && chown -R node:node /data


WORKDIR /app


# Copy built application from builder stage
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.js ./next.config.js


# Copy s6 service definitions
COPY s6-overlay/ /etc/s6-overlay/


# Copy scripts
COPY scripts/ /app/scripts/
RUN chmod +x /app/scripts/*.sh


# Environment variables with defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV RQLITE_HTTP_PORT=4001
ENV RQLITE_RAFT_PORT=4002
ENV RQLITE_DATA_DIR=/data/rqlite


EXPOSE 3000 4001 4002


VOLUME ["/data/rqlite"]


# s6-overlay as entrypoint (manages multiple processes)
ENTRYPOINT ["/init"]