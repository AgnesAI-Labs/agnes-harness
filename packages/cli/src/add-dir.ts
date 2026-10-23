import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { tt } from '@agnes/cli-tui'
import { UsageError } from './errors.js'
import type { ParsedArgs } from './types.js'

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Validates `--add-dir` for this run and makes every directory absolute. It only applies to a new
 * session. Over `--connect` the paths belong to the daemon's machine, so they must already be
 * absolute and are not checked here; the daemon admits or refuses each one.
 */
export function resolveAddDirs(
  p: ParsedArgs,
  mode: 'tui' | 'print' | 'acp',
  io: { cwd: string; env: NodeJS.ProcessEnv },
  locale: string,
): void {
  if (p.addDir === undefined) return
  if (p.continue || p.resume !== undefined || p.command === 'resume')
    throw new UsageError(tt('adddir.newOnly', locale))
  if (mode === 'acp') throw new UsageError('--add-dir is not supported with ACP')
  const remote = p.connect !== undefined || io.env.AGNES_CONNECT !== undefined
  const base = p.cwd ?? io.cwd
  const dirs = new Set<string>()
  for (const dir of p.addDir) {
    if (remote ? !isAbsolute(dir) : !isDirectory(resolve(base, dir)))
      throw new UsageError(tt('adddir.notDirectory', locale, { dir }))
    dirs.add(remote ? dir : resolve(base, dir))
  }
  p.addDir = [...dirs]
}
