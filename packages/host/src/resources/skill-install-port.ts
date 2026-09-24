import type { FsPolicy } from '@agnes/core'
import type { SkillInstallRequest, SkillInstallResult } from '@agnes/extension-api'

/** Host stamps these fields from the mounted row and active tool invocation, never model arguments. */
export type SkillInstallInvocation = Readonly<{
  packageId: string
  snapshotId: string
  rowId: string
  leaseId: string
  toolUseId: string
  sessionKey: string
  /** Host-only compiled filesystem denials; the plugin never supplies these. */
  deniedPaths?: readonly string[]
  /** Complete trusted policy and volume semantics; never accepted from plugin arguments. */
  pathPolicy?: Readonly<{ policy: FsPolicy; caseSensitive: boolean }>
  input: SkillInstallRequest
}>
export type SkillInstallBridge = (
  invocation: SkillInstallInvocation,
  signal: AbortSignal,
) => Promise<SkillInstallResult>
