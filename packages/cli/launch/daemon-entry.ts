#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type RunAgnesdArgs, runAgnesd } from '@agnes/daemon'

type LocalWeb = { addr: string; origin: string }

function next(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value) throw new Error(`${flag} needs a value`)
  return value
}

/** Minimal production wrapper grammar. The daemon owns the actual profile/config parser. */
export function parseDaemonEntryArgs(argv: readonly string[]): {
  args: RunAgnesdArgs
  localWeb?: LocalWeb
} {
  const args: RunAgnesdArgs = { profile: 'local-dev' }
  let localWeb: LocalWeb | undefined
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value || value === 'start') continue
    if (value === '--profile') {
      args.profile = next(argv, index++, value)
    } else if (value === '--workspace') {
      args.workspace = next(argv, index++, value)
    } else if (value === '--socket') {
      args.socket = next(argv, index++, value)
    } else if (value === '--ws') {
      args.ws = next(argv, index++, value)
    } else if (value === '--data-dir') {
      args.dataDir = next(argv, index++, value)
    } else if (value === '--local-web-origin' || value === '--web-origin') {
      localWeb = { addr: localWeb?.addr ?? '127.0.0.1:0', origin: next(argv, index++, value) }
    } else if (value === '--local-web-addr' || value === '--web-addr') {
      localWeb = { addr: next(argv, index++, value), origin: localWeb?.origin ?? '' }
    } else if (value === '--home') {
      args.home = next(argv, index++, value)
    } else {
      throw new Error(`unknown flag ${value}`)
    }
  }
  if (localWeb?.origin === '') throw new Error('--local-web-origin is required with --local-web-addr')
  return localWeb ? { args, localWeb } : { args }
}

export async function runDaemonEntry(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseDaemonEntryArgs(argv)
  if (parsed.args.home !== undefined) process.env.AGH_HOME = parsed.args.home
  const packagedWorker = join(dirname(fileURLToPath(import.meta.url)), 'worker.mjs')
  const sourceWorker = join(dirname(fileURLToPath(import.meta.url)), 'worker-entry.ts')
  const workerEntry = existsSync(packagedWorker)
    ? packagedWorker
    : existsSync(sourceWorker)
      ? sourceWorker
      : (() => {
          throw new Error('Agnes local worker entry is unavailable; rebuild the production distribution')
        })()
  await runAgnesd(parsed.args, {
    workerEntry,
    ...(workerEntry.endsWith('.ts') ? { workerExecArgv: ['--import', 'tsx'] } : {}),
    ...(parsed.localWeb ? { localWeb: parsed.localWeb } : {}),
  })
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return pathToFileURL(entry).href === moduleUrl
  }
}

if (isMainModule(import.meta.url))
  void runDaemonEntry().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
