import { SHELL_SENTINEL } from '../../tools-core/src/tools/shell.js'
import type { HookProcessResult } from './map.js'

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_COMMAND_LENGTH = 65_536
const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * An execution port that interprets `SHELL_SENTINEL` inside the configured sandbox. A raw process
 * adapter is not sufficient: it neither expands the sentinel nor proves process isolation.
 */
export type HookExec = (
  argv: string[],
  opts: {
    cwd: string
    env?: Record<string, string>
    stdin?: string
    timeoutMs?: number
    signal?: AbortSignal
    maxOutputBytes?: number
  },
) => Promise<{
  code: number
  stdout: string
  stderr: string
  truncated: boolean
  timedOut?: boolean
  signal?: string
}>

export type SubprocessHookSpec = {
  command: string
  timeoutMs: number
  cwd: string
  env: Record<string, string>
  signal?: AbortSignal
}

function validateSpec(spec: SubprocessHookSpec): void {
  if (spec.command.length === 0 || spec.command.length > MAX_COMMAND_LENGTH || spec.command.includes('\0'))
    throw new Error('invalid hook command')
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > MAX_TIMEOUT_MS)
    throw new Error('invalid hook timeout')
  if (spec.cwd.length === 0 || spec.cwd.includes('\0')) throw new Error('invalid hook cwd')
  for (const [key, value] of Object.entries(spec.env)) {
    if (key.length === 0 || key.includes('\0') || value.includes('\0'))
      throw new Error('invalid hook environment')
  }
}

export async function runSubprocess(
  exec: HookExec,
  spec: SubprocessHookSpec,
  payload: unknown,
): Promise<HookProcessResult> {
  validateSpec(spec)
  const stdin = JSON.stringify(payload)
  if (stdin === undefined) throw new Error('hook payload is not JSON serializable')

  const result = await exec([SHELL_SENTINEL, spec.command], {
    cwd: spec.cwd,
    env: { ...spec.env },
    stdin,
    timeoutMs: spec.timeoutMs,
    ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    maxOutputBytes: MAX_OUTPUT_BYTES,
  })
  if (result.timedOut) throw new Error('hook subprocess timed out')
  if (result.truncated) throw new Error('hook subprocess output was truncated')
  if (result.code !== 0 && result.code !== 2)
    throw new Error(`hook subprocess failed with exit ${result.code}`)

  let output: Record<string, unknown> | undefined
  if (result.stdout.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('hook subprocess JSON output must be an object')
      output = parsed as Record<string, unknown>
    } catch (error) {
      if (error instanceof SyntaxError) output = undefined
      else throw error
    }
  }
  return {
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(output === undefined ? {} : { output }),
  }
}
