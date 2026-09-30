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
  'packages/protocol/tools/gen-session.ts',
  'packages/protocol/tools/gen.ts',
  'packages/protocol/src/jcs.ts',
  'packages/protocol/src/runtime/jcs-digest.ts',
  'packages/protocol-validation/src/validate.ts',
  'biome.json',
] as const

export const GENERATED_FILES = [
  'packages/protocol/gen/ts/session-v1.ts',
  'packages/protocol/gen/ts/agnes-v1.ts',
  'packages/extension-api/src/runtime/index.ts',
  'packages/protocol/gen/ts/runtime-prototype.ts',
  'packages/protocol/src/runtime/index.ts',
  'packages/protocol/src/runtime/public.ts',
  'packages/protocol/src/runtime/validation.ts',
  'packages/protocol/gen/ts/runtime-public.ts',
  ...Array.from({ length: 16 }, (_, index) => `packages/protocol/gen/ts/runtime-public-${index + 1}.ts`),
  'packages/protocol/gen/ts/runtime-catalog.ts',
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
