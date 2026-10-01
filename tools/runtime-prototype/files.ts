import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { jcs } from '../../packages/protocol/src/jcs.js'

export type FileDigest = { path: string; sha256: string }

export const SOURCE_FILES = [
  'packages/protocol/schema/runtime/prototype.json',
  'packages/protocol/schema/runtime/public.json',
  'packages/protocol/schema/runtime/local-api.json',
  'packages/protocol/schema/runtime/empty-config.schema.json',
  'packages/protocol/schema/runtime/profile.schema.json',
  'packages/protocol/schema/runtime/preset.schema.json',
  'packages/protocol/schema/runtime/plugin-manifest.schema.json',
  'packages/protocol/schema/runtime/simple-loop.schema.json',
  'packages/protocol/schema/agnes-v1.json',
  'packages/protocol/schema/session-v1.json',
  'packages/protocol/schema/model.json',
  'packages/protocol/schema/jobs.json',
  'packages/protocol/schema/extension-manifest.json',
  'packages/protocol/tools/gen-core.ts',
  'packages/protocol/tools/gen-runtime.ts',
  'packages/protocol/tools/gen-runtime-full.ts',
  'packages/protocol/tools/gen-runtime-refs.ts',
  'packages/protocol/tools/gen-runtime-graph.ts',
  'packages/protocol/tools/gen-runtime-catalog.ts',
  'packages/protocol/tools/gen-client-transport.ts',
  'packages/protocol/tools/gen-client-transport-wire.ts',
  'packages/protocol/tools/gen-runtime-artifacts.ts',
  'packages/protocol/src/runtime/client-transport.ts',
  'packages/protocol/src/runtime/client-interaction-contract.ts',
  'packages/protocol/tools/gen-session.ts',
  'packages/protocol/tools/gen.ts',
  'packages/protocol/src/jcs.ts',
  'packages/protocol/src/runtime/jcs-digest.ts',
  'packages/protocol-validation/src/validate.ts',
  'packages/protocol-validation/src/index.ts',
  'packages/protocol-validation/src/json-data.ts',
  'packages/protocol-validation/src/canonical-json.ts',
  'packages/protocol-validation/src/byte-budget.ts',
  'packages/protocol-validation/src/byte-keywords.ts',
  'packages/protocol/src/runtime/codec-policy.ts',
  'packages/protocol/src/runtime/schema-document.ts',
  'packages/protocol/src/runtime/author-schema-source.ts',
  'packages/protocol/src/runtime/author-schema-subset.ts',
  'packages/protocol/tools/gen-author-schema.ts',
  'packages/protocol/tools/gen-author-schema-types.ts',
  'packages/protocol/tools/author-schema-json.ts',
  'packages/protocol/tools/build-author-schema-cli.mjs',
  'packages/extension-api/src/runtime/authoring.ts',
  'packages/extension-api/src/runtime/authoring-schemas.ts',
  'packages/extension-api/src/runtime/authoring-schema-core.ts',
  'packages/extension-api/src/runtime/authoring-source.ts',
  'packages/extension-api/src/runtime/authoring-hook-operations.ts',
  'packages/extension-api/src/runtime/artifact-authoring.ts',
  'LICENSE',
  'third-party/build-dependencies.json',
  'packages/protocol/schema/acp/schema.json',
  'packages/protocol/schema/authz.json',
  'packages/protocol/schema/bridge.json',
  'packages/protocol/schema/channel.json',
  'packages/protocol/schema/deploy-manifest.json',
  'packages/protocol/schema/extension-service.json',
  'packages/protocol/schema/hooks.json',
  'packages/protocol/schema/lockfile.json',
  'packages/protocol/schema/package-admin.json',
  'packages/protocol/schema/preset.json',
  'packages/protocol/schema/profile.json',
  'packages/protocol/schema/projection.json',
  'packages/protocol/schema/resource-control.json',
  'packages/protocol/gen/ts/resource-control.ts',
  'packages/protocol/schema/slots.json',
  'packages/protocol/schema/surface.json',
  'packages/protocol/schema/tooldef.json',
  'packages/protocol/schema/worker.json',
  'biome.json',
] as const

export const GENERATED_FILES = [
  'packages/protocol/gen/ts/acp.ts',
  'packages/protocol/gen/ts/authz.ts',
  'packages/protocol/gen/ts/bridge.ts',
  'packages/protocol/gen/ts/channel.ts',
  'packages/protocol/gen/ts/deploy-manifest.ts',
  'packages/protocol/gen/ts/extension-manifest.ts',
  'packages/protocol/gen/ts/extension-service.ts',
  'packages/protocol/gen/ts/hooks.ts',
  'packages/protocol/gen/ts/jobs.ts',
  'packages/protocol/gen/ts/lockfile.ts',
  'packages/protocol/gen/ts/model.ts',
  'packages/protocol/gen/ts/package-admin.ts',
  'packages/protocol/gen/ts/preset.ts',
  'packages/protocol/gen/ts/profile.ts',
  'packages/protocol/gen/ts/projection.ts',
  'packages/protocol/gen/ts/slots.ts',
  'packages/protocol/gen/ts/surface.ts',
  'packages/protocol/gen/ts/tooldef.ts',
  'packages/protocol/gen/ts/worker.ts',
  'packages/resource-control-contracts/src/gen/resource-control.ts',
  'packages/protocol/gen/ts/session-v1.ts',
  'packages/protocol/gen/ts/agnes-v1.ts',
  'packages/extension-api/src/runtime/index.ts',
  'packages/protocol/gen/ts/runtime-prototype.ts',
  'packages/protocol/src/runtime/index.ts',
  'packages/protocol/src/runtime/public.ts',
  'packages/protocol/src/runtime/validation.ts',
  'packages/protocol/gen/ts/runtime-public.ts',
  ...Array.from({ length: 24 }, (_, index) => `packages/protocol/gen/ts/runtime-public-${index + 1}.ts`),
  'packages/protocol/gen/ts/runtime-catalog.ts',
  'packages/protocol/gen/ts/runtime-client-transport.ts',
  'packages/protocol/gen/ts/runtime-artifact-policy.ts',
  'packages/protocol/src/runtime/artifacts.ts',
  'packages/extension-api/test/runtime/generated-client-transport.compile.ts',
  'packages/protocol/gen/ts/runtime-wire-types.ts',
  'packages/protocol/gen/ts/runtime-schema-refs.ts',
  'packages/extension-api/src/runtime/public-api.ts',
  'packages/extension-api/src/runtime/public-1.ts',
  'packages/extension-api/src/runtime/public-2.ts',
  'packages/extension-api/src/client/index.ts',
  'packages/extension-api/src/client/public-1.ts',
  'packages/extension-api/src/client/public-2.ts',
] as const

export const CHECKPOINT_FILES = [
  'packages/extension-api/package.json',
  'packages/extension-api/test/runtime/prototype-consumer.compile.ts',
  'packages/extension-api/test/runtime/authoring-consumer.compile.ts',
  'packages/extension-api/test/runtime/owned-author-schema-consumer.compile.ts',
  'packages/extension-api/test/runtime/generated/owned-schema/Message.ts',
  'packages/extension-api/test/runtime/generated/owned-schema/defineGeneratedAuthor.ts',
  'packages/extension-api/test/runtime/client-types.compile.ts',
  'packages/protocol/test/runtime/skin-token-consumer.compile.ts',
  'packages/extension-api/test/runtime/authority-directory-consumer.compile.ts',
  'packages/extension-api/test/runtime/standard-hook-operations-consumer.compile.ts',
  'packages/extension-api/test/runtime/integrity-consumer.compile.ts',
  'packages/extension-api/test/runtime/contract-tail-consumer.compile.ts',
  'packages/extension-api/test/runtime/client-transport-consumer.compile.ts',
  'packages/extension-api/test/runtime/artifact-consumer.compile.ts',
  'packages/extension-api/test/runtime/interaction-event-consumer.compile.ts',
  'packages/extension-api/test/runtime/legacy-identity-consumer.compile.ts',
  'packages/protocol/package.json',
  'package.json',
  'pnpm-lock.yaml',
  'tools/check-runtime-prototype-checkpoint.ts',
  'tools/runtime-prototype/checkpoint.ts',
  'tools/runtime-prototype/compile.ts',
  'tools/runtime-prototype/files.ts',
  'tools/runtime-prototype/tsconfig.compile.json',
] as const

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function jsonDigest(value: unknown): string {
  return sha256(jcs(value))
}

/** Manifests contain only regular files inside the checkout, never machine paths or symlinks. */
export function digestFiles(root: string, paths: readonly string[]): FileDigest[] {
  const canonicalRoot = realpathSync(root)
  return [...new Set(paths)].sort().map((path) => {
    if (
      isAbsolute(path) ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error(`invalid manifest path: ${path}`)
    const absolute = resolve(canonicalRoot, path)
    if (relative(canonicalRoot, realpathSync(absolute)).replaceAll('\\', '/') !== path)
      throw new Error(`manifest file must remain inside checkout without symlinks: ${path}`)
    return { path, sha256: sha256(readFileSync(absolute)) }
  })
}
