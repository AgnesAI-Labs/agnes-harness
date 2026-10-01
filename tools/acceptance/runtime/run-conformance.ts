import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
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

export interface RunConformanceOptions {
  readonly contracts: readonly string[] | 'all'
  readonly providers: readonly string[]
  readonly command: string
  readonly clock: InjectedClock
  readonly reportPath: string | null
}

export async function runConformance(options: RunConformanceOptions): Promise<{
  readonly report: ConformanceReport
  readonly reportPath: string
}> {
  const harness = createConformanceHarness()
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
