// 跨文件共用的小类型：`tool.ts` / `extension.ts` 与 02 文件的 `hooks.ts` / `slots.ts` 都从这里 import，
// 保证 `Seq` / `SessionRef` / `LeaseView` / `Logger` 全仓只有一处定义（计划 Self-Review「类型一致」）。
import type { JsonValue } from '@agnes/protocol'

export type JsonSchema = { [key: string]: JsonValue }
export type Seq = number
export type SessionKey = string
export type Disposer = () => void
export type Bytes = Uint8Array
export type TelemetryConsent = 'DISABLED' | 'LOCAL' | 'ANON' | 'FULL'

export interface SessionRef {
  readonly key: SessionKey
  readonly lane: string
  /** Canonical workspace identity selected by the Host for this session. Data only, never authority. */
  readonly workspaceRoot: string
  readonly turn?: number
  readonly step?: number
  /** Host-resolved once when the session hook port is created; absent on older hosts. */
  readonly telemetryConsent?: TelemetryConsent
  /** True when a profile-local consent change must be audited as this session starts. */
  readonly telemetryConsentPendingAudit?: boolean
}

export interface LeaseView {
  /**
   * ISO timestamp. For a row-bound lease this is a far-future sentinel: the lease really ends when
   * it is revoked or its row is unloaded, so do not schedule work against it.
   */
  readonly expiresAt: string
  readonly scope: {
    readonly services?: readonly string[]
    readonly projections?: readonly string[]
    readonly events?: boolean
    readonly slots?: readonly string[]
    readonly toolPrefix?: string
  }
  readonly budget: { readonly remaining: number } // execute 次数
}

export type Logger = Record<'debug' | 'info' | 'warn' | 'error', (msg: string, fields?: JsonValue) => void>

// The private stand-in this package carried is gone: protocol defines ArtifactRef in
// session-v1.json and puts it on its root export surface, so the authoritative shape is imported
// rather than restated. Two definitions of one wire shape drift without anything going red.
export type { ArtifactRef } from '@agnes/protocol'

// Read-only platform facts every extension may see at every moment (spec 2026-09-15 §4 row 9).
// Plain data on purpose: it crosses the isolated JSON boundary unchanged, and a hook or a factory
// gets exactly this - no probe, no method - so the same type serves in-process and isolated alike.
export type PlatformFacts = Readonly<{
  shell: 'posix' | 'powershell'
  fs: Readonly<{ caseSensitive: boolean; pathSep: string }>
  terminal: Readonly<{ color: boolean; width?: number }>
}>
export type CapabilityReport = Readonly<{
  level: 'full' | 'partial' | 'unavailable'
  scope: readonly string[]
  reason?: string
}>
/** Tool and service time add the live capability probe; the facts themselves are the same object shape. */
export interface PlatformView extends PlatformFacts {
  capability(id: string): CapabilityReport
}
// Structurally identical to core's Enforcement; restated here because this package never imports
// core (the dependency runs the other way) and a tool needs the shape to read the answer.
export type SandboxEnforcement = Readonly<{
  level: 'full' | 'partial' | 'none'
  scope: readonly ('file' | 'network' | 'process')[]
}>
