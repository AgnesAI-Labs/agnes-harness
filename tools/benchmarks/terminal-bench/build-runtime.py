"""Build a frozen, container-compatible AGH payload without changing this checkout."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import urllib.request
import uuid
from urllib.parse import urlsplit


BASE = "node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
EXCLUDED = {"node_modules", "dist", ".git", ".cache", "__pycache__",
            ".agents", ".codex", ".claude", ".agh", ".aws", ".ssh", ".secrets"}
PRIVATE_FILES = {"configuration.json", "jev-configuration.json", "credentials.json", "sessions.db"}


def build_proxy(value: str) -> str:
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme == "http" and parsed.hostname and parsed.port != 0 and
                 not parsed.username and not parsed.password and parsed.path in ("", "/") and
                 not parsed.query and not parsed.fragment and not any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value))
    except ValueError:
        valid = False
    if not valid:
        raise argparse.ArgumentTypeError("build proxy must be an unauthenticated HTTP endpoint")
    return value.rstrip("/")


def snapshot(source: Path, output: Path) -> dict:
    listed = subprocess.check_output(["git", "-C", str(source), "ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    files = []
    root_files = {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.base.json", "NOTICE", "LICENSE"}
    for item in listed.decode().split("\0"):
        if not item:
            continue
        relative = Path(item)
        if relative.parts[0] not in {"packages", "tools", "third-party", "patches"} and item not in root_files:
            continue
        path = source / relative
        if any(part in EXCLUDED for part in relative.parts) or path.is_symlink() or not path.is_file():
            continue
        if path.name in PRIVATE_FILES or (path.name.startswith(".env") and path.name != ".env.example") or path.suffix in {".pem", ".key", ".pyc"}:
            continue
        files.append(path)
    digest = hashlib.sha256()
    fixture_hashes = {}
    with tarfile.open(output / "source.tar", "w") as archive:
        for path in sorted(set(files)):
            relative = path.relative_to(source).as_posix()
            before = path.stat()
            data = path.read_bytes()
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise RuntimeError("source changed during snapshot")
            digest.update(relative.encode() + b"\0" + hashlib.sha256(data).digest())
            if relative in {"tools/benchmarks/terminal-bench/driver.ts", "tools/benchmarks/terminal-bench/pricing.ts"}:
                fixture_hashes[relative] = hashlib.sha256(data).hexdigest()
            info = archive.gettarinfo(path, arcname=relative)
            import io
            archive.addfile(info, io.BytesIO(data))
    if len(fixture_hashes) != 2:
        raise RuntimeError("source snapshot lacks driver/pricing source")
    head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    return {"schema_version": "agh-tb-source/v1", "source_content_sha256": digest.hexdigest(),
            "git_head_locator": head, "git_head_role": "locator-only; source_content_sha256 is authoritative",
            "fixture_source_hashes": fixture_hashes,
            "file_count": len(files), "source_archive_sha256": hashlib.sha256((output / "source.tar").read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--build-proxy", type=build_proxy)
    args = parser.parse_args()
    source, output = args.source_root.resolve(), args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    receipt = snapshot(source, output)
    receipt["build_proxy"] = {"endpoint": args.build_proxy, "scope": "docker-build-args-only; not runtime environment"}
    node_license = urllib.request.urlopen(
        "https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE", timeout=30
    ).read()
    if hashlib.sha256(node_license).hexdigest() != "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace":
        raise RuntimeError("Node license revision drifted")
    (output / "NODE-LICENSE").write_bytes(node_license)
    (output / "Dockerfile").write_text(f"""FROM {BASE}
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates patchelf && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.34.5
WORKDIR /source
ADD source.tar /source/
COPY NODE-LICENSE /source/NODE-LICENSE
RUN pnpm install --frozen-lockfile && pnpm --filter @agnes/cli build:local
RUN mkdir -p /payload/agh/node/bin /payload/agh/node/lib && cp /usr/local/bin/node /payload/agh/node/bin/node && cp -a packages/cli/dist/local/. /payload/agh/
RUN node tools/benchmarks/terminal-bench/build-driver.mjs --source-root /source --outfile /payload/agh/driver.mjs
RUN for lib in $(ldd /usr/local/bin/node | awk '/libstdc\\+\\+|libgcc_s/ {{print $3}}'); do cp -L "$lib" /payload/agh/node/lib/; done
RUN patchelf --set-rpath '$ORIGIN/../lib' /payload/agh/node/bin/node
RUN mkdir -p /payload/agh/THIRD-PARTY-NOTICES && cp /source/NODE-LICENSE /payload/agh/THIRD-PARTY-NOTICES/node.txt && cp /usr/share/doc/libstdc++6/copyright /payload/agh/THIRD-PARTY-NOTICES/gcc-runtime.txt
RUN tar -C /payload/agh -cf /agh-dist.tar .
""")
    image = "agh-tb-payload:" + uuid.uuid4().hex[:12]
    with (output / "build.log").open("wb") as log:
        build_args = [] if args.build_proxy is None else ["--build-arg", "HTTP_PROXY=" + args.build_proxy,
                                                       "--build-arg", "HTTPS_PROXY=" + args.build_proxy,
                                                       "--build-arg", "NO_PROXY=localhost,127.0.0.1,::1"]
        subprocess.run(["docker", "build", "--progress=plain", *build_args, "-t", image, str(output)], stdout=log, stderr=subprocess.STDOUT, check=True)
    receipt["builder_image_id"] = json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]["Id"]
    container = subprocess.check_output(["docker", "create", image], text=True).strip()
    try:
        subprocess.run(["docker", "cp", container + ":/agh-dist.tar", str(output / "agh-dist.tar")], check=True)
    finally:
        subprocess.run(["docker", "rm", container], check=True, stdout=subprocess.DEVNULL)
    receipt["distribution_sha256"] = hashlib.sha256((output / "agh-dist.tar").read_bytes()).hexdigest()
    (output / "source-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"distribution": str(output / "agh-dist.tar"), "sha256": receipt["distribution_sha256"]}))


if __name__ == "__main__":
    main()
