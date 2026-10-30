ARG NODE_VERSION
FROM node:${NODE_VERSION}-bullseye AS node
FROM debian:buster-slim
# The compiler/sysroot intentionally target glibc 2.28; no runtime OS libraries are copied out.
RUN printf 'deb http://archive.debian.org/debian buster main\ndeb http://archive.debian.org/debian-security buster/updates main\n' > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates curl perl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/include/node /usr/local/include/node
# Static, private OpenSSL 3 avoids imposing a distro-specific libcrypto SONAME on users.
RUN curl -fL https://www.openssl.org/source/openssl-3.5.9.tar.gz -o /tmp/openssl.tar.gz \
    && echo '603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a  /tmp/openssl.tar.gz' | sha256sum -c - \
    && tar -xf /tmp/openssl.tar.gz -C /tmp \
    && cd /tmp/openssl-3.5.9 \
    && ./config no-shared no-module no-tests -fPIC --prefix=/opt/openssl --libdir=lib \
    && make -j2 build_libs \
    && make install_dev \
    && cp LICENSE.txt /opt/openssl/LICENSE.txt \
    && rm -rf /tmp/openssl*
RUN touch /opt/agnes-native-builder
WORKDIR /src
