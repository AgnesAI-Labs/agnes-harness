import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Logger, WindowsWriteBoundary } from '@agnes/extension-api'
import { mkdirDurablySync, publishFileDurablySync, removeFileDurablySync } from '@agnes/package-manager'
import {
  executionRecordRefusal,
  planWindowsExecution,
  type SessionExecutionGeneration,
  type WindowsExecutionVerification,
  type WindowsWorkspaceBinding,
  windowsWorkspaceBinding,
  workspaceConfirmation,
} from './session-sandbox-windows.js'

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
  backend: 'none' | 'l1' | 'remote' | 'windows-acl'
  enforcement: Readonly<{
    level: 'none' | 'partial' | 'full'
    scope: readonly string[]
    boundary?: WindowsWriteBoundary
  }>
}>

const refusal = executionRecordRefusal

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
  private file(key: string): string {
    return join(this.root, createHash('sha256').update(key).digest('hex') + '.json')
  }
  release(key: string): void {
    removeFileDurablySync(this.file(key))
  }
  verify(key: string, execution: SandboxExecutionRecord, hasHistory: boolean): void {
    const file = this.file(key)
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

  /**
   * Windows sessions keep a version 2 record: the original version 1 value stays as written, and
   * the execution generation the next commands run under is appended only when the saved evidence
   * proves it. The record is durable before this returns; nothing may run under the generation
   * before that.
   */
  verifyWindowsExecution(
    key: string,
    input: WindowsExecutionVerification,
    hasHistory: boolean,
  ): SessionExecutionGeneration {
    return this.windows(key, input, hasHistory, 'verify')
  }

  /**
   * The user confirmed that the directory now at the session's saved workspace root, a different
   * object than the one it was verified with, is still its workspace. The session keeps its key,
   * history and files; a missing record or another root is refused, never started anew.
   */
  confirmWindowsWorkspace(
    key: string,
    input: Readonly<{
      workspaceRoot: string
      rootIdentity: NonNullable<WindowsWorkspaceBinding['rootIdentity']>
    }>,
  ): SessionExecutionGeneration {
    let bytes: string | undefined
    try {
      bytes = readFileSync(this.file(key), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw refusal()
    }
    return this.windows(key, workspaceConfirmation(key, bytes, input), true, 'confirm')
  }

  /** Every readable version 2 record and the workspace it is bound to; others are left out. */
  windowsWorkspaces(): WindowsWorkspaceBinding[] {
    let names: string[]
    try {
      names = readdirSync(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const bindings: WindowsWorkspaceBinding[] = []
    for (const name of names.filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry)).sort()) {
      let bytes: string
      try {
        bytes = readFileSync(join(this.root, name), 'utf8')
      } catch {
        continue
      }
      const binding = windowsWorkspaceBinding(bytes)
      if (binding && this.file(binding.sessionKey) === join(this.root, name)) bindings.push(binding)
    }
    return bindings
  }

  private windows(
    key: string,
    input: WindowsExecutionVerification,
    hasHistory: boolean,
    mode: 'verify' | 'confirm',
  ): SessionExecutionGeneration {
    const file = this.file(key)
    const read = (): string | undefined => {
      try {
        return readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw refusal()
      }
    }
    const bytes = read()
    const plan = planWindowsExecution({ key, bytes, verification: input, hasHistory, mode, canAdoptHistory })
    if (!plan.changed) return plan.generation
    const next = JSON.stringify(plan.record)
    mkdirDurablySync(this.root, dirname(this.profileDir))
    // A record that appeared meanwhile is accepted only if it says exactly the same.
    publishFileDurablySync(file, next, bytes === undefined ? {} : { replace: true })
    if (read() !== next) throw refusal()
    if (hasHistory)
      this.log?.info('Adopted session execution history under a new execution generation', {
        sessionHash: createHash('sha256').update(key).digest('hex'),
        reason: plan.generation.reason,
        backend: plan.generation.backend,
      })
    return plan.generation
  }
}
