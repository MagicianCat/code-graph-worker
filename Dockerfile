FROM ghcr.io/abhigyanpatwari/gitnexus@sha256:7c9d62db60ce0b3ecccc1143b1866f3d5f67d8e594cc9b305e733a0a53a76469

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends zstd \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/code-graph-worker /data/code-graph \
    && chown -R node:node /app/code-graph-worker /data/code-graph
COPY --chown=node:node package.json /app/code-graph-worker/package.json
COPY --chown=node:node src /app/code-graph-worker/src
USER node
WORKDIR /app/code-graph-worker

ENV PORT=8080 \
    CODE_GRAPH_DATA_ROOT=/data/code-graph \
    GITNEXUS_HOME=/data/code-graph/gitnexus-home \
    GITNEXUS_BIN=/usr/local/bin/gitnexus \
    GITNEXUS_VERSION=1.6.12 \
    GITNEXUS_NO_UPDATE_NOTIFIER=1

EXPOSE 8080
CMD ["node", "src/server.js"]
