import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResourceLimits } from '@agnes/protocol/runtime'
import type { ExecutionMetrics, OwnedExecutionResult } from './resource-owners.js'

export type WindowsExecutionInput = {
  argv: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  stdin: Uint8Array
  limits: ResourceLimits | Omit<ResourceLimits, 'openFiles'>
  signal: AbortSignal
  governor?: string
  /** Explicit internal execution without a File ceiling; never passed through Exec admission. */
  fileMode?: 'files' | 'five-limits'
}
export function windowsGovernorPath(): string {
  const location = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(location, 'native/exec-governor.exe'),
    join(location, '../../../native/exec-governor.exe'),
    join(location, '../../../dist/native/exec-governor.exe'),
  ]
  return candidates.find((path) => existsSync(path)) ?? candidates[2] ?? ''
}

/** Raw, unqualified backend. Job membership does not supply sandbox isolation. */
export function runWindowsJobExecution(input: WindowsExecutionInput): Promise<OwnedExecutionResult> {
  const limits = input.limits
  if (input.signal.aborted) return Promise.reject(new Error('exec_cancelled'))
  if ('openFiles' in limits || input.fileMode !== 'five-limits')
    return Promise.reject(new Error('exec_limit_openFiles_unsupported'))
  if (
    ![limits.cpuMs, limits.wallMs, limits.memoryBytes, limits.outputBytes, limits.processes].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    limits.wallMs >= 0xffffffff ||
    limits.cpuMs > 922337203685477 ||
    limits.outputBytes > 64 * 1024 * 1024 ||
    limits.processes > 65535 ||
    input.stdin.length > 1024 * 1024 ||
    !input.argv.length ||
    input.argv.some((value) => value.includes('\0'))
  )
    return Promise.reject(new Error('exec_resource_bounds'))
  return new Promise((resolve, reject) => {
    const child = spawn(
      input.governor ?? windowsGovernorPath(),
      [limits.cpuMs, limits.wallMs, limits.memoryBytes, limits.outputBytes, limits.processes]
        .map(String)
        .concat('five-limits', ...input.argv),
      { cwd: input.cwd, env: { ...input.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    const output: Buffer[][] = [[], []]
    let kept = 0
    let pending = ''
    let invalid = false
    let refusal: string | undefined
    let terminal: ExecutionMetrics | undefined
    const stop = () => child.stdin?.end('cancel')
    const bad = () => {
      invalid = true
      stop()
    }
    child.stdin?.on('error', () => {})
    input.signal.addEventListener('abort', stop, { once: true })
    const length = Buffer.alloc(4)
    length.writeUInt32LE(input.stdin.length)
    child.stdin?.write(Buffer.concat([length, Buffer.from(input.stdin)]))
    if (input.signal.aborted) stop()
    child.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('ascii')
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const row = pending.slice(0, end)
        pending = pending.slice(end + 1)
        try {
          if (row.length > 4096) throw new Error('Oversized frame')
          const frame = JSON.parse(row) as Record<string, unknown>
          if (terminal || refusal) throw new Error('Repeated terminal')
          if (frame.kind === 'refusal') {
            if (
              kept ||
              ![
                'exec_runner_unavailable',
                'exec_cleanup_unknown',
                'exec_resource_bounds',
                'exec_limit_openFiles_unsupported',
              ].includes(String(frame.detailCode))
            )
              throw new Error('Invalid refusal')
            refusal = String(frame.detailCode)
          } else if (frame.kind === 'output') {
            if (
              (frame.stream !== 0 && frame.stream !== 1) ||
              typeof frame.hex !== 'string' ||
              frame.hex.length > 2048 ||
              !/^(?:[0-9a-f]{2})*$/u.test(frame.hex)
            )
              throw new Error('Invalid output')
            const bytes = Buffer.from(frame.hex, 'hex')
            if (kept + bytes.length > limits.outputBytes) throw new Error('Output exceeds ceiling')
            output[frame.stream]?.push(bytes)
            kept += bytes.length
          } else {
            const metrics = frame as unknown as ExecutionMetrics
            if (
              frame.kind !== 'metrics' ||
              metrics.final !== true ||
              metrics.ownership !== 'strong' ||
              metrics.ownershipVerified !== true ||
              metrics.remaining !== 0 ||
              metrics.filesEnforced !== false ||
              ![
                'pid',
                'cpuMs',
                'rss',
                'committedBytes',
                'processes',
                'files',
                'outputBytes',
                'intervalMs',
                'maxGapMs',
                'residualObserved',
              ].every((key) => Number.isSafeInteger(frame[key]) && Number(frame[key]) >= 0) ||
              metrics.pid <= 0 ||
              metrics.intervalMs !== 10 ||
              metrics.residualObserved !== 0 ||
              !Number.isSafeInteger(metrics.code) ||
              metrics.signal !== 0 ||
              ![
                'completed',
                'cpuMs',
                'wallMs',
                'memoryBytes',
                'outputBytes',
                'processes',
                'cancel',
                'owner',
                'residual',
                'unavailable',
              ].includes(metrics.reason) ||
              metrics.outputBytes < kept ||
              (metrics.reason === 'completed' && metrics.outputBytes > limits.outputBytes)
            )
              throw new Error('Invalid ownership evidence')
            terminal = metrics
          }
        } catch {
          bad()
        }
      }
      if (pending.length > 4096) {
        bad()
        pending = ''
      }
    })
    // Helper diagnostics never become command output or retained private material.
    child.stderr?.resume()
    child.once('error', () => {
      input.signal.removeEventListener('abort', stop)
      reject(new Error('exec_runner_unavailable'))
    })
    child.once('close', (status) => {
      input.signal.removeEventListener('abort', stop)
      if (invalid || pending || ![0, 125].includes(status ?? -1)) reject(new Error('exec_cleanup_unknown'))
      else if (refusal && status === 125) reject(new Error(refusal))
      else if (!terminal || status !== 0) reject(new Error('exec_cleanup_unknown'))
      else
        resolve({
          stdout: Buffer.concat(output[0] ?? []),
          stderr: Buffer.concat(output[1] ?? []),
          metrics: terminal,
        })
    })
  })
}
