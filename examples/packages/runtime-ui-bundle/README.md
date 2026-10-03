# Runtime UI bundle fixture

`v1/` is a small, hand-written runtime plugin package (`example.runtime-ui-bundle` 1.0.0) whose bytes
are real and whose digests can be recomputed. It is a read-only Web UI bundle input for release
planning and package tests. It is not listed in the local examples catalog and is not installed by any
test.

## Contents

- `agnes.plugin.json`: a `RuntimePluginManifest` with a Web entry, one view schema, one Web renderer and
  one stylesheet in `clientAssets`. It declares no runtime entry, providers, domains, tools,
  dependencies, client services or permissions.
- `schemas/status-card.schema.json`: the view schema `example.runtime-ui-bundle/status-card@1`,
  revision 1, a closed author schema document.
- `web/index.js`: the Web entry. It has no imports and does nothing when it loads; its `component`
  export shows the view as one line of text. The renderer descriptor stays in the manifest, so the
  module does not depend on the package digest.
- `web/index.css`: the stylesheet named in `clientAssets.styles`.

## Digests

- `files[]` lists every package file except `agnes.plugin.json`, with the SHA-256 and length of its raw
  bytes. The manifest does not list itself.
- `schemas[].ref.digest` is the SHA-256 of the RFC 8785 (JCS) form of the schema document, so
  formatting the file does not change it; its `files[]` digest covers the raw bytes.
- `packageDigest`, at the top level and in `renderers[]`, is the digest of the sorted package tree.
  The tree includes `agnes.plugin.json` as its JCS form with every own-package `packageDigest` field (the
  top-level field, each `renderers[].packageDigest` and each `clientServices[].packageDigest`)
  replaced by 64 zeros. Each tree record has the path, mode, length and SHA-256 of the bytes; the
  digest is the SHA-256 of the JCS form of those records sorted by UTF-8 path.
- The default and reference readers zero the known own-package digest fields before hashing and
  fill them with the computed digest in the final manifest. Other digest fields stay hashed.

`build` records honest values for a hand-written package: `generatorVersion` is `0.0.0` because no
generator produced it, `sourceDigest` is the JCS SHA-256 of the `files[]` list because the listed
files are the whole source, `authorDefinitionDigest` is 64 zeros because there is no author
definition, and `reproducible` is `false`.

## Recomputing

`packages/package-manager/test/runtime/runtime-ui-bundle-example.test.ts` recomputes every digest:
it reads `v1/` with `readPackageTree` and passes the unmodified tree to the readers, whose tree
digest must equal the manifest's `packageDigest`. An independent canonical-tree calculation also
checks the declared value. The schema reference is recomputed with `validateOwnedAuthorSchemaSource` from
`@agnes/protocol/runtime`.

After editing a file, update its `files[]` entry and `build.sourceDigest`, then the schema reference
if the schema changed, and finally `packageDigest` in both places. A changed package must use a new
version: the same id and version with a different `packageDigest` is a conflict.

Tampered and same-version-changed variants are built in memory by that test and are not committed.
