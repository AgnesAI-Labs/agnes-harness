#!/usr/bin/env node
import { lstatSync } from 'node:fs'
import { constants, enableCompileCache } from 'node:module'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPrivateDirectorySync, hasPrivateDaclSync } from '@agnes/system-node'
import { timingMark } from '../src/timing.js'
import { versionLine } from '../src/version-line.js'

/** build-local sets this to the large bundle each tiny local entry loads. */
declare const AGNES_BOOTSTRAP_MAIN: string | undefined
/** build-local sets this to the protocol's AGH_DIR, so this entry never loads the protocol package. */
declare const AGNES_BOOTSTRAP_HOME_DIR: string
/** build-local sets this for the `agh` entry only: the version `--version` reports without loading the bundle. */
declare const AGNES_BOOTSTRAP_VERSION: string | undefined

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

/**
 * The home `agnesHome` selects, or undefined where it would refuse. Kept local because the shared
 * resolver imports the protocol package, whose load time is what this entry exists to cache; the
 * equality is pinned by test. The real entry reports an invalid or retired home setting.
 */
export function compileCacheHome(
  env: Readonly<Record<string, string | undefined>>,
  homeDir?: string,
): string | undefined {
  if (nonEmpty(env.AGNES_HOME) !== undefined) return undefined
  const explicit = nonEmpty(env.AGH_HOME)
  const selected = explicit ?? nonEmpty(env.HOME) ?? homedir()
  if (sep === '\\' && (!isAbsolute(selected) || parse(selected).root.length <= 1)) return undefined
  if (explicit !== undefined && !isAbsolute(explicit)) return undefined
  return explicit ?? join(selected, homeDir ?? AGNES_BOOTSTRAP_HOME_DIR)
}

/**
 * Use `<home>/cache/compile` only when it is a private directory of this user, so nobody else can
 * plant compiled code. `<home>/cache` is never created here: an uninitialized home must stay empty,
 * and the first initialized start enables the cache. Every failure just starts without the cache.
 */
export function enableLocalCompileCache(
  env: Readonly<Record<string, string | undefined>> = process.env,
  enable: (directory: string) => { status: number } = enableCompileCache,
): string | undefined {
  try {
    const home = compileCacheHome(env)
    if (home === undefined) return undefined
    const directory = join(home, 'cache', 'compile')
    try {
      createPrivateDirectorySync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
    }
    if (!lstatSync(directory).isDirectory() || !hasPrivateDaclSync(directory)) return undefined
    const { status } = enable(directory)
    return status === constants.compileCacheStatus.ENABLED ||
      status === constants.compileCacheStatus.ALREADY_ENABLED
      ? directory
      : undefined
  } catch {
    return undefined
  }
}

if (typeof AGNES_BOOTSTRAP_MAIN === 'string') {
  timingMark('bootstrap')
  const args = process.argv.slice(2)
  if (
    typeof AGNES_BOOTSTRAP_VERSION === 'string' &&
    args.length === 1 &&
    (args[0] === '--version' || args[0] === '-v')
  ) {
    // Exactly the line the main bundle prints for these arguments, without the 25 MB load. Left to
    // exit on its own so a piped stdout drains.
    process.stdout.write(versionLine(AGNES_BOOTSTRAP_VERSION))
    process.exitCode = 0
  } else {
    enableLocalCompileCache()
    const main = fileURLToPath(new URL(AGNES_BOOTSTRAP_MAIN, import.meta.url))
    // The bundles keep their own main-module guards, which compare argv[1] with their own file.
    process.argv[1] = main
    await import(pathToFileURL(main).href)
  }
}
