import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Logger } from '@agnes/extension-api'
import { mkdirDurablySync, publishFileDurablySync, removeFileDurablySync } from '@agnes/package-manager'

export type SandboxExecutionRecord = Readonly<{
  workspaceId: string
  workspaceRoot: string
  policyDigest: string
  staticConfigHash: string
  provider: string
  providerVersion: string
  target: string
  implementation: 'implemented' | 'unimplemented' | 'unknown'
  probeState: 'ready' | 'failed' | 'unprobed'
  backend: 'none' | 'l1' | 'remote'
  enforcement: Readonly<{ level: 'none' | 'partial' | 'full'; scope: readonly string[] }>
}>

const refusal = () =>
  Object.assign(
    new Error(
      'E_SANDBOX_WORKSPACE: saved execution policy is missing or incompatible; keep this history and create a new session',
    ),
    { code: 'E_SANDBOX_WORKSPACE', reason: 'session-execution-record-invalid' },
  )

/**
 * Before execution records existed, historical sessions required OS isolation (L1).
 * Adopting only an implemented, ready L1 backend with full file isolation cannot weaken that history.
 */
function canAdoptHistory(execution: SandboxExecutionRecord): boolean {
  return (
    execution.backend === 'l1' &&
    execution.implementation === 'implemented' &&
    execution.probeState === 'ready' &&
    execution.enforcement.level === 'full' &&
    execution.enforcement.scope.includes('file')
  )
}

/** Actual workspace result, separate from composition intent. First publication wins. */
export class SessionSandboxStore {
  private readonly root: string
  constructor(
    private readonly profileDir: string,
    private readonly log?: Pick<Logger, 'info'>,
  ) {
    this.root = join(profileDir, '.session-sandbox')
  }
  release(key: string): void {
    removeFileDurablySync(join(this.root, createHash('sha256').update(key).digest('hex') + '.json'))
  }
  verify(key: string, execution: SandboxExecutionRecord, hasHistory: boolean): void {
    const file = join(this.root, createHash('sha256').update(key).digest('hex') + '.json')
    const expected = { version: 1, sessionKey: key, execution }
    const read = (): unknown => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw refusal()
      }
    }
    const existing = read()
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, expected)) throw refusal()
      return
    }
    if (hasHistory && !canAdoptHistory(execution)) throw refusal()
    mkdirDurablySync(this.root, dirname(this.profileDir))
    publishFileDurablySync(file, JSON.stringify(expected))
    if (!isDeepStrictEqual(read(), expected)) throw refusal()
    if (hasHistory)
      this.log?.info('Adopted missing session execution record under full L1 isolation', {
        sessionHash: createHash('sha256').update(key).digest('hex'),
      })
  }
}
