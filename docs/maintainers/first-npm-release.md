# How to cut the first npm release

English | [简体中文](first-npm-release.zh-CN.md)

[Release checks](release.md) · [Versioning](versioning.md)

**Not done yet.** No public npm release is approved by these scripts. Workspace packages remain private. The existing candidate is `@agnes/harness`, with the `agh` executable; package names stay unchanged pending the user's decision.

Local preparation needs Node.js 24.10+, pinned pnpm, npm/npx and `tar`. The registry smoke currently runs on macOS/Linux; Windows smoke needs a process-tree shutdown implementation and is refused before startup. The local registry has no upstream connection; offline packing needs the locked dependencies and native build headers already cached.

- [ ] Choose and approve the public package set, version, npm scope ownership and supported platforms. The current pack contains one self-contained CLI tarball for the build host only, with `os`/`cpu` restrictions. Different platform builds of the same name/version cannot be published separately; review a cross-platform distribution design before promising multiple platforms.
- [ ] Freeze the source revision. Use Node.js 24.10+ and pinned pnpm 10.34.5, install locked dependencies, then follow the [release checks](release.md). Native builds require the platform toolchain and cached Node headers for offline builds.
- [ ] Run `pnpm release:pack`. Review `dist/release/pack-result.json` and the tarball: name/version, executable, exports, embedded manifests, native payload, prebuilt Web assets, LICENSE, NOTICE and third-party notices. The guard runs before packing and against the extracted tarball, refusing workspace/local dependency leaks, missing entrypoints/assets and development-only runtime dependencies. Bundled esbuild is needed for plugin authoring.
- [ ] Review [cached license provenance](../../third-party/pack-licenses/README.md), notice inventories and libvips's bundled library licensing/redistribution requirements. Some upstream packages supply only SPDX metadata, not full license notices; obtain or approve the complete attribution before any public distribution. Source and distribution licensing remain separate review scopes.
- [ ] Run `pnpm release:npx-smoke`. It builds the candidate, publishes it only to a temporary loopback registry with no uplinks, installs through npx with an empty cache and isolated HOME/AGH_HOME, checks version, doctor, Web health/assets and shutdown, and writes `dist/release/npx-smoke-result.json`. No provider account or browser is needed. The runtime phase uses npm offline mode. With a prepared tarball, pass `--tarball /absolute/candidate.tgz`; use `--report /absolute/result.json` to preserve evidence elsewhere.
- [ ] Repeat acceptance on every promised OS/architecture. Record install bytes and cold-start timing, failures and untested environments. A host smoke does not certify models, external MCP, sandbox behavior or other platforms.
- [ ] The user approves the reviewed artifacts and the actual public publish operation. Only then may the release owner publish the chosen artifacts to the explicitly approved registry, verify installation from that registry in a fresh environment, and update release notes/install guides. Tags and releases require their own authorization.

These commands perform local preparation and local-registry validation only. They never publish to npm or create tags/releases. Successful smoke evidence is preparation, not proof that the first public release has happened.
