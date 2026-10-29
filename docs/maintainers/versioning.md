# Versions and compatibility

English | [简体中文](versioning.zh-CN.md)

<a id="版本与兼容性"></a>

[Documentation](../README.md) · [Release checks](release.md)

AGH currently ships as pre-alpha source revisions. Record the Git revision and use documentation, examples, and build artifacts from the same version. Configuration, protocols, and extension interfaces may introduce breaking changes during preview.

<a id="包版本"></a>

## Package versions

Independently distributed packages use Semantic Versioning, managed according to each package's interface. `0.0.0` marks unpublished development packages and must not be published directly to npm. `private: true` prevents accidental package publication without changing the source license.

Extension API has its own version and [changelog](../../packages/extension-api/docs/CHANGELOG.md). A package version does not establish overall product stability or acceptance across platforms.

A workspace deploy manifest states the harness it supports in `harnessRange`. That range is checked against the harness contract version, `HARNESS_VERSION` exported by `@agnes/protocol` and equal to that package's version. It is not checked against a build's own version, so an unpublished `0.0.0` build accepts the manifests written for the contract it implements.

The first npm distribution requires a selected package set, release versions, compatibility notes, and dependency resolution. Remove `private` only from selected packages. Breaking published interfaces requires a major increment, compatible features a minor increment, and compatible fixes a patch increment. Release tags use `<package-name>@v<version>`. Publishing resolves `workspace:*` dependencies to compatible versions, while the repository lockfile continues to pin development and CI dependencies.

Read change notes and preserve required data before upgrading. Runtime data is not migrated. Unsupported home layouts require a new home; incompatible SQLite directories require the [data-format recovery](../guide/install.md#data-format-and-upgrade) procedure, preserving profiles. Replace runtime builds and switch Git revisions separately; a version-number edit performs none of these operations.
