import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  type ConformanceHarness,
  type ConformanceReport,
  createConformanceHarness,
  type InjectedClock,
} from '../../../packages/extension-api/testkit/index.js'
import { writeReport } from './report.js'

const USAGE =
  'usage: tsx tools/acceptance/runtime/run-conformance.ts --contracts <all|name,name> --providers <id,id> [--report <path>]'

export interface ParsedConformanceArgs {
  readonly contracts: readonly string[] | 'all'
  readonly providers: readonly string[]
  readonly reportPath: string | null
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

export function parseConformanceArgs(argv: readonly string[]): ParsedConformanceArgs {
  let contracts: string | null = null
  let providers: string | null = null
  let reportPath: string | null = null
  let index = 0
  while (index < argv.length) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === undefined || !flag.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(USAGE)
    }
    if (flag === '--contracts') {
      if (contracts !== null) throw new Error(USAGE)
      contracts = value
    } else if (flag === '--providers') {
      if (providers !== null) throw new Error(USAGE)
      providers = value
    } else if (flag === '--report') {
      if (reportPath !== null) throw new Error(USAGE)
      reportPath = value
    } else {
      throw new Error(USAGE)
    }
    index += 2
  }
  if (contracts === null || providers === null) throw new Error(USAGE)
  const providerIds = splitList(providers)
  if (providerIds.length === 0) throw new Error(USAGE)
  if (contracts.trim() === 'all') return { contracts: 'all', providers: providerIds, reportPath }
  const names = splitList(contracts)
  if (names.length === 0 || names.includes('all')) throw new Error(USAGE)
  return { contracts: names, providers: providerIds, reportPath }
}

export interface ConformanceBindRequest {
  readonly command: string
  readonly contracts: readonly string[] | 'all'
  readonly providers: readonly string[]
}

export interface ConformanceBindResult {
  readonly contracts: readonly string[]
  readonly providers: readonly string[]
}

export interface RunConformanceOptions {
  readonly contracts: readonly string[] | 'all'
  readonly providers: readonly string[]
  readonly command: string
  readonly clock: InjectedClock
  readonly reportPath: string | null
  readonly binderFiles?: readonly string[]
}

const RUNTIME_ROOT = dirname(fileURLToPath(import.meta.url))

function posixPath(file: string): string {
  return file.split(sep).join('/')
}

function binderSortKey(file: string): string {
  const rel = posixPath(relative(RUNTIME_ROOT, file))
  if (rel.startsWith('..')) return posixPath(file)
  return rel
}

function sortedBinders(files: readonly string[]): string[] {
  return [...files].sort((left, right) => {
    const a = binderSortKey(left)
    const b = binderSortKey(right)
    if (a < b) return -1
    if (a > b) return 1
    return 0
  })
}

export function conformanceBinderFiles(root = RUNTIME_ROOT): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'dist' || entry.name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name === 'run-conformance.ts' || entry.name.endsWith('.test.ts')) continue
      if (!entry.name.endsWith('-conformance.ts')) continue
      found.push(full)
    }
  }
  walk(root)
  return sortedBinders(found)
}

function binderLabel(file: string): string {
  const rel = posixPath(relative(RUNTIME_ROOT, file))
  return rel.startsWith('..') ? posixPath(file) : rel
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadBindConformance(
  file: string,
): Promise<(harness: ConformanceHarness, request: ConformanceBindRequest) => Promise<unknown>> {
  const label = binderLabel(file)
  let imported: { bindConformance?: unknown }
  try {
    imported = (await import(pathToFileURL(file).href)) as { bindConformance?: unknown }
  } catch (error) {
    throw new Error(`conformance module failed to load: ${label}: ${failureText(error)}`, { cause: error })
  }
  if (typeof imported.bindConformance !== 'function') {
    throw new Error(`conformance module failed to load: ${label}: missing bindConformance`)
  }
  return imported.bindConformance as (
    harness: ConformanceHarness,
    request: ConformanceBindRequest,
  ) => Promise<unknown>
}

function readClaim(value: unknown, label: string): ConformanceBindResult {
  const record = value as { contracts?: unknown; providers?: unknown } | null
  const contracts = record !== null && typeof record === 'object' ? record.contracts : undefined
  const providers = record !== null && typeof record === 'object' ? record.providers : undefined
  if (
    !Array.isArray(contracts) ||
    !contracts.every((item) => typeof item === 'string') ||
    !Array.isArray(providers) ||
    !providers.every((item) => typeof item === 'string')
  ) {
    throw new Error(
      `conformance module failed to load: ${label}: bindConformance must return contracts and providers`,
    )
  }
  return { contracts: [...new Set(contracts)], providers: [...providers] }
}

async function registerRequestedContracts(
  harness: ConformanceHarness,
  options: RunConformanceOptions,
): Promise<void> {
  const files = sortedBinders(options.binderFiles ?? conformanceBinderFiles())
  const claims: { file: string; contracts: readonly string[] }[] = []
  for (const file of files) {
    const label = binderLabel(file)
    const bind = await loadBindConformance(file)
    let raw: unknown
    try {
      raw = await bind(harness, {
        command: options.command,
        contracts: options.contracts,
        providers: options.providers,
      })
    } catch (error) {
      throw new Error(`conformance module failed to load: ${label}: ${failureText(error)}`, { cause: error })
    }
    claims.push({ file: label, ...readClaim(raw, label) })
  }
  const owners = new Map<string, string[]>()
  for (const claim of claims) {
    for (const contract of claim.contracts) {
      const list = owners.get(contract) ?? []
      list.push(claim.file)
      owners.set(contract, list)
    }
  }
  const duplicates = [...owners.entries()].filter(([, list]) => list.length > 1)
  if (duplicates.length > 0) {
    const detail = duplicates.map(([contract, list]) => `${contract}: ${list.join(', ')}`).join('; ')
    throw new Error(`conformance contract claimed by more than one module: ${detail}`)
  }
}

export async function runConformance(options: RunConformanceOptions): Promise<{
  readonly report: ConformanceReport
  readonly reportPath: string
}> {
  const harness = createConformanceHarness()
  await registerRequestedContracts(harness, options)
  const report = await harness.run({
    contracts: options.contracts,
    providers: options.providers,
    command: options.command,
    clock: options.clock,
  })
  const reportPath =
    options.reportPath ?? join(mkdtempSync(join(tmpdir(), 'conformance-')), 'conformance.json')
  writeReport(reportPath, report)
  return { report, reportPath }
}

export async function main(
  argv: readonly string[],
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  let parsed: ParsedConformanceArgs
  try {
    parsed = parseConformanceArgs(argv)
  } catch (error) {
    stderr(error instanceof Error ? error.message : USAGE)
    return 2
  }
  const stamp = new Date().toISOString()
  try {
    const { report, reportPath } = await runConformance({
      contracts: parsed.contracts,
      providers: parsed.providers,
      command: ['tsx tools/acceptance/runtime/run-conformance.ts', ...argv].join(' '),
      clock: { startedAt: stamp, finishedAt: stamp },
      reportPath: parsed.reportPath,
    })
    stdout(reportPath)
    return report.status === 'passed' ? 0 : 1
  } catch (error) {
    stderr(error instanceof Error ? error.message : 'conformance run failed')
    return 1
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (invokedDirectly()) {
  main(
    process.argv.slice(2),
    (line) => {
      process.stdout.write(`${line}\n`)
    },
    (line) => {
      process.stderr.write(`${line}\n`)
    },
  ).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : 'conformance run failed'
      process.stderr.write(`${message}\n`)
      process.exitCode = 1
    },
  )
}
