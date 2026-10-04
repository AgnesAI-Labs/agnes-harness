import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResourceLimits } from '@agnes/protocol/runtime'
import { createPlatform } from '../../adapters/platform.js'

export type ExecutionMetrics = {
  pid: number
  final: boolean
  reason: string
  code: number
  signal: number
  cpuMs: number
  rss: number
  processes: number
  files: number
  outputBytes: number
  intervalMs: number
  remaining: number
  maxGapMs: number
  ownershipVerified: boolean
  residualObserved: number
  ownership: string
  /** Windows native qualification: committed allocation is separate from sampled RSS. */
  committedBytes?: number
  filesEnforced?: boolean
}
export type OwnedExecutionResult = { stdout: Uint8Array; stderr: Uint8Array; metrics: ExecutionMetrics }
export const EXEC_SAMPLE_MS = 10
export function executionGovernorPath(): string {
  const location = dirname(fileURLToPath(import.meta.url))
  const paths = [
    join(location, 'native/exec-governor'),
    join(location, '../../../native/exec-governor'),
    join(location, '../../../dist/native/exec-governor'),
  ]
  return paths.find((path) => existsSync(path)) ?? paths[2] ?? ''
}

/** The native owner survives its caller; pipe EOF closes and reaps the owned tree. */
export function runOwnedExecution(input: {
  argv: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  stdin: Uint8Array
  limits: ResourceLimits
  signal: AbortSignal
  cwdFd?: number
  rootFd?: number
  cwdRoot?: string
  governor?: string
  /** Trusted, exclusive, empty cgroup v2 delegation with protected controls; never plugin-supplied. */
  cgroupDirectoryFd?: number
  observed?: (metrics: ExecutionMetrics) => void
}): Promise<OwnedExecutionResult> {
  for (const [name, value] of Object.entries(input.limits))
    if (value === 0) return Promise.reject(new Error(`exec_zero_${name}`))
  if (createPlatform().os === 'win32') return Promise.reject(new Error('exec_limit_openFiles_unsupported'))
  if (createPlatform().os === 'linux' && input.cgroupDirectoryFd === undefined)
    return Promise.reject(new Error('exec_delegation_unsupported'))
  if (input.signal.aborted) return Promise.reject(new Error('exec_cancelled'))
  const l = input.limits
  const child = spawn(
    input.governor ?? executionGovernorPath(),
    [l.cpuMs, l.wallMs, l.memoryBytes, l.outputBytes, l.processes, l.openFiles]
      .map(String)
      .concat(input.cwdRoot ? [input.cwdRoot, ...input.argv] : input.argv),
    {
      cwd: input.cwdRoot ?? input.cwd,
      env: { ...input.env },
      stdio: [
        'pipe',
        'pipe',
        'pipe',
        'pipe',
        'pipe',
        input.cgroupDirectoryFd ?? 'ignore',
        input.cwdFd ?? 'ignore',
        input.rootFd ?? 'ignore',
      ],
    },
  )
  const output: Buffer[][] = [[], []]
  let collected = 0,
    line = ''
  let businessObserved = false
  let admissionRefusal: string | undefined
  let terminal: ExecutionMetrics | undefined
  let malformed = false
  const stop = () => {
    child.stdin?.end('cancel')
  }
  input.signal.addEventListener('abort', stop, { once: true })
  if (input.signal.aborted) stop()
  child.stdin?.on('error', () => {})
  const source = child.stdio[4]
  if (source && 'end' in source) {
    source.on('error', () => {})
    source.end(Buffer.from(input.stdin))
  }
  for (const [index, stream] of [child.stdout, child.stderr].entries()) {
    stream?.on('data', (bytes: Buffer) => {
      const keep = bytes.subarray(0, Math.max(0, l.outputBytes - collected))
      collected += keep.length
      output[index]?.push(keep)
      if (bytes.length !== keep.length) {
        malformed = true
        stop()
      }
    })
  }
  child.stdio[3]?.on('data', (bytes: Buffer) => {
    line += bytes.toString('utf8')
    if (line.length > 16384) {
      malformed = true
      stop()
      line = ''
      return
    }
    for (let end = line.indexOf('\n'); end >= 0; end = line.indexOf('\n')) {
      const value = line.slice(0, end)
      line = line.slice(end + 1)
      try {
        const frame = JSON.parse(value) as ExecutionMetrics & { refused?: unknown }
        if (typeof frame.refused === 'string' && /^exec_[a-zA-Z_]+$/u.test(frame.refused)) {
          if (admissionRefusal || businessObserved || Object.keys(frame).length !== 1)
            throw new Error('Invalid native refusal')
          admissionRefusal = frame.refused
          continue
        }
        if (admissionRefusal) throw new Error('Metrics after admission refusal')
        const metrics = frame
        if (
          !Number.isSafeInteger(metrics.pid) ||
          metrics.pid <= 0 ||
          typeof metrics.reason !== 'string' ||
          ![
            'cpuMs',
            'rss',
            'processes',
            'files',
            'outputBytes',
            'intervalMs',
            'maxGapMs',
            'residualObserved',
          ].every(
            (key) =>
              Number.isSafeInteger(metrics[key as keyof ExecutionMetrics]) &&
              Number(metrics[key as keyof ExecutionMetrics]) >= 0,
          ) ||
          !Number.isSafeInteger(metrics.remaining) ||
          metrics.remaining < -1 ||
          typeof metrics.ownershipVerified !== 'boolean' ||
          !['cooperative', 'strong'].includes(metrics.ownership) ||
          typeof metrics.final !== 'boolean' ||
          !Number.isSafeInteger(metrics.code) ||
          !Number.isSafeInteger(metrics.signal) ||
          (metrics.ownershipVerified && metrics.remaining !== 0 && metrics.final)
        )
          throw new Error('Malformed native metrics')
        businessObserved = true
        if (metrics.final) terminal = metrics
        input.observed?.(metrics)
      } catch {
        malformed = true
        stop()
      }
    }
  })
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('exec_runner_unavailable')))
    child.once('close', (code) => {
      input.signal.removeEventListener('abort', stop)
      if (code === 125 && admissionRefusal && !malformed && !line && collected === 0 && !terminal)
        reject(new Error(admissionRefusal))
      else if (
        ![0, 125].includes(code ?? -1) ||
        malformed ||
        !terminal ||
        (terminal.reason === 'completed' && (!terminal.ownershipVerified || terminal.remaining !== 0))
      )
        reject(new Error('exec_cleanup_unknown'))
      else
        resolve({
          stdout: Buffer.concat(output[0] ?? []),
          stderr: Buffer.concat(output[1] ?? []),
          metrics: terminal,
        })
    })
  })
}
