FROM node:24.20.0-bookworm-slim
COPY --from=ccr.ccs.tencentyun.com/ags-image/envd:v0.5.14 \
  --chmod=755 /usr/bin/envd /usr/bin/envd
# Bootstrap HTTPS with the pinned Node runtime's bundled trust roots. Debian's
# ca-certificates package replaces this bootstrap bundle during installation.
RUN node -e "const fs=require('node:fs');fs.mkdirSync('/etc/ssl/certs',{recursive:true});fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('node:tls').rootCertificates.join('\n'))" \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git python3 bubblewrap tini coreutils iproute2 \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
COPY install-litestream.sh /tmp/install-litestream.sh
RUN sh /tmp/install-litestream.sh && rm /tmp/install-litestream.sh
COPY sync/package.json sync/package-lock.json /opt/agh/sync/
RUN cd /opt/agh/sync && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY sync/ /opt/agh/sync/
COPY --chmod=755 bin/ /opt/agh/bin/
ARG SOURCE_REVISION
ARG CLOUD_PLUGIN_VERSION=0.9.2-successful-tools.20261119.1
LABEL org.opencontainers.image.title="AGH cloud runtime" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${CLOUD_PLUGIN_VERSION}"
COPY runtime/ /opt/agh/runtime/
COPY cloud.tgz /opt/agh/plugins/cloud.tgz
COPY --chmod=755 start.sh /opt/agh/start.sh
COPY --chmod=755 start.sh /opt/agh/start-llmsg.sh
COPY healthcheck.mjs verify-plugin.mjs THIRD_PARTY.md /opt/agh/
ENV WORKSPACE_DIR=/workspace/data AGH_HOME=/data/agh AGH_ASSETS_DIR=/data/agh-assets AGH_SYNC_DIR=/run/agh-sync
RUN mkdir -p /workspace/data /data/agh /run/agh-sync \
    && test -n "${SOURCE_REVISION}" \
    && chmod 700 /data/agh /run/agh-sync \
    && bash -n /opt/agh/start.sh \
    && node /opt/agh/verify-plugin.mjs /opt/agh/plugins/cloud.tgz "${CLOUD_PLUGIN_VERSION}" \
    && node -e "require('/opt/agh/runtime/node_modules/@agnes/system-node/dist/native/agnes-system.node')" \
    && node /opt/agh/runtime/agnes.mjs --help > /dev/null
USER root
WORKDIR /
EXPOSE 8443 49983
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "/opt/agh/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["/opt/agh/start-llmsg.sh"]
