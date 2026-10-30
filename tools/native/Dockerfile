ARG NODE_VERSION
FROM node:${NODE_VERSION}-bullseye AS node
FROM debian:buster-slim
# The compiler/sysroot intentionally target glibc 2.28; no runtime OS libraries are copied out.
RUN printf 'deb http://archive.debian.org/debian buster main\ndeb http://archive.debian.org/debian-security buster/updates main\n' > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/include/node /usr/local/include/node
RUN touch /opt/agnes-native-builder
WORKDIR /src
