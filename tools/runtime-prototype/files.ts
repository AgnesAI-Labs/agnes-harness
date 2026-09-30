import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { jcs } from '../../packages/protocol/src/jcs.js'

export type FileDigest = { path: string; sha256: string }

export const SOURCE_FILES = [
  'packages/protocol/schema/runtime/prototype.json',
  'packages/protocol/tools/gen-core.ts',
  'packages/protocol/tools/gen-runtime.ts',
  'packages/protocol/tools/gen.ts',
  'packages/protocol/src/jcs.ts',
  'packages/protocol-validation/src/validate.ts',
] as const

export const GENERATED_FILES = [
  'packages/extension-api/src/runtime/index.ts',
  'packages/protocol/gen/ts/runtime-prototype.ts',
  'packages/protocol/src/runtime/index.ts',
] as const

export const CHECKPOINT_FILES = [
  'packages/extension-api/package.json',
  'packages/extension-api/test/runtime/prototype-consumer.compile.ts',
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
