ARG AGH_BASE_IMAGE=agh-cloud:0.7.0-llmsg-runtime-r3-20261118
FROM ${AGH_BASE_IMAGE} AS node-toolchain
FROM debian:buster-slim AS builder
RUN printf 'deb http://archive.debian.org/debian buster main\ndeb http://archive.debian.org/debian-security buster/updates main\n' > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates git python3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node
COPY --from=node-toolchain /usr/local/include/node /usr/local/include/node
COPY --from=node-toolchain /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN node /usr/local/lib/node_modules/npm/bin/npm-cli.js install --prefix /opt/pnpm pnpm@10.34.5 --ignore-scripts --no-audit --no-fund \
 && ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && touch /opt/agnes-native-builder
ENV npm_execpath=/opt/pnpm/node_modules/pnpm/bin/pnpm.cjs AGNES_NATIVE_BUILDER=glibc228 CI=true
ADD core-source.tar /build/core/
ADD plugin-source.tar /build/plugin/
WORKDIR /build/core
RUN node tools/toolchain/run.mjs install --frozen-lockfile
RUN node --test integrations/llmsg/command-network.test.mjs integrations/llmsg/prepare-image.test.mjs
RUN node integrations/llmsg/command-network.mjs /build/core
RUN node tools/toolchain/run.mjs --filter @agnes/cli build:local --output-dir /out/runtime
RUN node tools/toolchain/run.mjs exec node /build/plugin/author-checks.mjs /build/core
RUN AGH_HOME=/tmp/agh-image-pack node /out/runtime/agnes.mjs plugins pack /build/plugin /out/cloud.tgz
RUN mkdir /out/packed && tar -xzf /out/cloud.tgz -C /out/packed --strip-components=1
RUN node tools/toolchain/run.mjs exec node /build/plugin/author-checks.mjs /build/core /out/packed
RUN cd /out/runtime && find . -type f -print0 | sort -z | xargs -0 sha256sum > /out/runtime.SHA256SUMS \
 && cd /out && sha256sum cloud.tgz > cloud.SHA256SUMS

FROM ${AGH_BASE_IMAGE} AS runtime
ARG CORE_REVISION
ARG CLOUD_PLUGIN_REVISION
ARG LLMSG_ENTRYPOINT_REVISION
RUN test -z "${AGH_CLOUD_KEY:-}" && test -z "${AGH_API_KEY:-}" && test -z "${OPENAI_API_KEY:-}" \
 && test ! -e /data/agh/cloud-key && test ! -L /data/agh/cloud-key \
 && test ! -e "${AGH_HOME:-/data/agh}/cloud-key" && test ! -L "${AGH_HOME:-/data/agh}/cloud-key"
RUN rm -rf /opt/agh/runtime
COPY --from=builder /out/runtime/ /opt/agh/runtime/
COPY --from=builder /out/cloud.tgz /opt/agh/plugins/cloud.tgz
COPY --from=builder /out/runtime.SHA256SUMS /opt/agh/runtime.SHA256SUMS
COPY --from=builder /out/cloud.SHA256SUMS /opt/agh/plugins/cloud.SHA256SUMS
COPY --chmod=0755 packaging/start.sh /opt/agh/start-llmsg.sh
COPY --chmod=0755 packaging/start.sh /opt/agh/start.sh
RUN test -n "$CORE_REVISION" && test -n "$CLOUD_PLUGIN_REVISION" && test -n "$LLMSG_ENTRYPOINT_REVISION" \
 && cmp /opt/agh/start.sh /opt/agh/start-llmsg.sh \
 && bash -n /opt/agh/start.sh \
 && cd /opt/agh/runtime && sha256sum -c /opt/agh/runtime.SHA256SUMS >/dev/null \
 && cd /opt/agh/plugins && sha256sum -c cloud.SHA256SUMS
LABEL org.opencontainers.image.title="AGH cloud sandbox" \
 org.opencontainers.image.revision=$CORE_REVISION \
 io.agnes.cloud-plugin.revision=$CLOUD_PLUGIN_REVISION \
 io.agnes.llmsg-entrypoint.revision=$LLMSG_ENTRYPOINT_REVISION
