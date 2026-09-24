import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createPrivateDirectorySync,
  createPrivateFileSync,
  renameDirectoryNoReplaceSync,
  syncDirectorySync,
} from '@agnes/system-node'
import { type InstallBundle, installError, unlinked, within } from './skill-install-files.js'

/** Publish the complete private stage without replacing an existing destination on any platform. */
export function publishInstallBundle(target: string, bundle: InstallBundle, check: () => void): void {
  const root = unlinked(dirname(target))
  const parent = unlinked(dirname(root))
  mkdirSync(parent, { recursive: true })
  const stage = join(parent, `.skill-install-${randomUUID()}`)
  if (!within(parent, stage) || within(root, stage)) throw installError('SKILL_STAGE_INVALID')
  createPrivateDirectorySync(stage)
  try {
    const directories = new Set([stage])
    for (const [name, bytes] of bundle.files) {
      check()
      const file = unlinked(join(stage, name))
      if (!within(stage, file)) throw installError('SKILL_STAGE_INVALID')
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      for (let directory = dirname(file); directory !== stage; directory = dirname(directory))
        directories.add(directory)
      const fd = createPrivateFileSync(file)
      try {
        writeFileSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      check()
      syncDirectorySync(unlinked(directory))
    }
    check()
    unlinked(root)
    mkdirSync(root, { recursive: true })
    unlinked(target)
    if (existsSync(target)) throw installError('SKILL_TARGET_CONFLICT')
    try {
      renameDirectoryNoReplaceSync(stage, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'ENOTEMPTY') throw installError('SKILL_TARGET_CONFLICT')
      if (['ENOSYS', 'ENOTSUP', 'EINVAL', 'E_SYSTEM_NATIVE_UNAVAILABLE'].includes(code ?? ''))
        throw installError('SKILL_ATOMIC_PUBLISH_UNAVAILABLE')
      throw error
    }
  } finally {
    // Only this private, randomly named staging directory is ours to remove.
    if (existsSync(stage)) {
      unlinked(stage)
      rmSync(stage, { recursive: true })
    }
  }
}
