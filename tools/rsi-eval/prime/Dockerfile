# syntax=docker/dockerfile:1
#
# Prime Agent for unattended evaluation runs, built from source at a pinned commit.
#
# Building needs network access (apt, rustup, GitHub, the Rust crate index, the uv
# release, a managed Python 3.11 and the Python wheels for the kernel venv) and takes
# a while (a full release build of the Rust workspace, roughly 10 to 30 minutes).
#
#   docker build -t rsi-eval-prime:9cf0d47 tools/rsi-eval/prime
#   docker run --rm rsi-eval-prime:9cf0d47 prime-agent --version
#
# Prime Agent has no sandbox: its worker and kernel run code with the permissions of
# the current user. Only ever run this image in a container, and mount a throwaway
# copy of the task workspace at /work. The container runs as the non-root user
# `prime` (uid 1000); mounted directories must be writable by that uid.
#
# Pinned inputs: the Prime Agent commit, the Rust toolchain, rustup and uv. The base
# image is the ubuntu:22.04 tag; the prebuilt release binaries need glibc >= 2.35, and
# this image builds from source on the same glibc (2.35) it runs on.

ARG PRIME_AGENT_COMMIT=9cf0d47e2f1775379af9b105ef1f9d5e9f7dd25d
ARG RUST_VERSION=1.98.1
ARG RUSTUP_VERSION=1.28.2
ARG UV_VERSION=0.13.6

# ---------------------------------------------------------------- build stage
FROM ubuntu:22.04 AS build
ARG PRIME_AGENT_COMMIT
ARG RUST_VERSION
ARG RUSTUP_VERSION

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential curl ca-certificates git python3 binutils pkg-config \
 && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    PATH=/opt/cargo/bin:${PATH}

RUN arch="$(uname -m)-unknown-linux-gnu" \
 && curl -fsSL -o /tmp/rustup-init \
      "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${arch}/rustup-init" \
 && chmod +x /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
 && rm /tmp/rustup-init \
 && rustc --version

RUN git init /src \
 && cd /src \
 && git remote add origin https://github.com/PrimeIntellect-ai/prime-agent \
 && git fetch --depth 1 origin "${PRIME_AGENT_COMMIT}" \
 && git checkout --detach FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "${PRIME_AGENT_COMMIT}"

# LTO and debug info are switched off through the environment: the default release profile links
# with thin LTO, which runs out of memory in an 8 GB Docker VM. Behavior is unchanged.
RUN cd /src && CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_DEBUG=false CARGO_BUILD_JOBS=4 \
    cargo build --release --locked -p pa-cli

# -------------------------------------------------------------- runtime stage
FROM ubuntu:22.04
ARG UV_VERSION

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git make python3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /bin/bash prime \
 && mkdir /work /agent \
 && chown prime:prime /work /agent

# uv builds the kernel venv and installs the managed Python 3.11 that Prime asks for
# (Ubuntu 22.04 ships 3.10 only).
RUN arch="$(uname -m)" \
 && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${arch}-unknown-linux-gnu.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local/bin \
 && uv --version

# Exe-adjacent layout: the binary finds its kernel runtime sidecar and skills next to itself.
COPY --from=build --chown=prime:prime /src/target/release/prime-agent /opt/prime-agent/prime-agent
COPY --from=build --chown=prime:prime /src/prime-agent-runtime /opt/prime-agent/prime-agent-runtime
COPY --from=build --chown=prime:prime /src/skills /opt/prime-agent/skills
COPY --from=build --chown=prime:prime /src/docs /opt/prime-agent/docs
RUN ln -s /opt/prime-agent/prime-agent /usr/local/bin/prime-agent

USER prime
ENV HOME=/home/prime \
    PI_PACKAGE_DIR=/opt/prime-agent \
    PRIME_AGENT_TELEMETRY=0

# Pre-build the kernel venv so no run has to download anything.
RUN prime-agent --prime-agent-bootstrap

WORKDIR /work
