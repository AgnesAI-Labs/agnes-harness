import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { guardPackage } from './pack-guard.js'

/** Refuse escaping paths and links before extraction, including operator-supplied candidates. */
export function guardTarEntries(paths: readonly string[], modes: readonly string[]): void {
  if (!paths.length || paths.length !== modes.length) throw new Error('Invalid tarball inventory')
  const seen = new Set<string>()
  for (const [index, entry] of paths.entries()) {
    const path = entry.replace(/\/$/, '')
    if (
      (path !== 'package' && !path.startsWith('package/')) ||
      posix.normalize(path) !== path ||
      path.includes('\\') ||
      [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      seen.has(path) ||
      !['-', 'd'].includes(modes[index] ?? '')
    )
      throw new Error(`Unsafe tarball entry: ${entry}`)
    seen.add(path)
  }
}

export async function guardTarball(tarball: string, triple: string): Promise<void> {
  const archive = resolve(tarball)
  const options = { encoding: 'utf8' as const, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }
  const paths = execFileSync('tar', ['-tzf', archive], options).trimEnd().split('\n')
  const modes = execFileSync('tar', ['-tvzf', archive], options)
    .trimEnd()
    .split('\n')
    .map((line) => line[0] ?? '')
  guardTarEntries(paths, modes)
  const root = await mkdtemp(join(tmpdir(), 'agh-tarball-audit-'))
  try {
    execFileSync('tar', ['-xzf', archive, '-C', root], options)
    await guardPackage(join(root, 'package'), triple)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
