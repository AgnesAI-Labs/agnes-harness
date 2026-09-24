# Release checks

English | [简体中文](release.zh-CN.md)

<a id="发布检查"></a>

[Documentation](../README.md) · [Versioning](versioning.md) · [Verification](verification.md)

Release from an explicit source revision and a reviewed distribution tree. Public source, npm packages, and prebuilt installers have separate acceptance requirements.

<a id="源码版本"></a>

## Source revision

- Install locked dependencies in a fresh directory, build CLI/Web/daemon/worker, and run relevant tests and local process acceptance.
- Run bilingual documentation checks, types, lint, generation checks, and repository guards. Record actual failures and untested platforms.
- Check both README editions, supported scope, and examples against the implementation. Release notes should state capabilities, installation method, and compatibility changes.
- Review files and Git references being published. History, attachments, and configuration must contain no private material, credentials, or personal data.
- Preserve LICENSE, NOTICE, dependency provenance, and component notices. Review the dependencies, assets, and binaries actually packaged.

<a id="仓库入口"></a>

## Repository entry points

- The default branch contains the full source, and clone URLs and README instructions work.
- Issues accepts ordinary feedback through bug/request forms. PR creation follows the current Collaborators only policy.
- Invited-developer permissions, main-branch review requirements, and required checks are configured correctly.
- Enable and verify Security → Advisories → Report a vulnerability on the public repository. Keep [SECURITY.md](../../SECURITY.md) accurate about the reporting channel.
- About, topics, documentation links, and version notes point to usable content. Demonstration material comes from real runs.

<a id="npm-分发门"></a>

## npm distribution gate

The [release-readiness guard](../../tools/guards/src/release-readiness.test.ts) keeps the following item aligned with the [machine inventory](../../tools/guards/release-readiness-todos.json). This gates npm distribution; the root LICENSE governs source licensing.

- [ ] `packages.private` — Select public packages, assign non-placeholder versions, and remove `private` only from those packages. Tooling packages remain private to package registries.

Passing checks establishes only their executed scope. Validate real models, external MCP, platforms, devices, and installers in their own environments.
