import type { JsonValue } from '@agnes/protocol'

export type ComputerUseSessionRef = Readonly<{ key: string; lane: string }>

export type FakeCaptureTarget =
  | Readonly<{ kind: 'frontmost' }>
  | Readonly<{ kind: 'app'; app: string }>
  | Readonly<{ kind: 'pid'; pid: number }>
  | Readonly<{ kind: 'window'; pid: number; windowId: number }>
  | Readonly<{ kind: 'screen' }>
  | Readonly<{ kind: 'desktop' }>

export type FakeCaptureRequest = Readonly<{
  mode: 'som' | 'vision' | 'ax'
  target: FakeCaptureTarget
}>

export type ComputerUseResetReason =
  | 'session_end'
  | 'cancel'
  | 'idle'
  | 'reload'
  | 'mode_change'
  | 'transport_suspect'

export type ComputerUseDriverPermissionMode = 'standard' | 'bounded' | 'unrestricted'

export type DriverCloseReason = 'eof' | 'timeout' | 'cancel' | 'driver_exit' | 'protocol_error' | 'closed'

export type DriverCloseEvent = Readonly<{
  generation: number
  reason: DriverCloseReason
  /** Host-authored lifecycle context. The fake driver can never set this field. */
  resetReason?: ComputerUseResetReason
}>

export type DriverContent =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'image'; data: string; mimeType: string }>

export type DriverToolContract = Readonly<{
  name: string
  description: string
  inputSchema: JsonValue
  capabilities: readonly string[]
  capabilityVersion: string
}>

export type DriverCallResult = Readonly<{
  content: readonly DriverContent[]
  structuredContent?: JsonValue
  isError: boolean
}>

export interface FakeComputerUseDriverConnection {
  readonly generation: number
  readonly capabilityVersion: string
  readonly catalog: ReadonlyMap<string, DriverToolContract>
  /** Test-only process identity, never a production driver admission handle. */
  readonly pid: number
  /** Opaque per-process identity used by isolation assertions. */
  readonly transportId: string
  call(
    name: string,
    args: JsonValue,
    options: { timeoutMs: number; signal: AbortSignal },
  ): Promise<DriverCallResult>
  onClose(listener: (event: DriverCloseEvent) => void): () => void
  close(reason: string): Promise<void>
}

export type FakeDriverCommand = Readonly<{
  command: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  startupTimeoutMs?: number
  closeGraceMs?: number
}>

/**
 * The transport was introduced with the fake driver, but it intentionally speaks the same locked
 * stdio MCP contract as the production driver. Keep the old names as compatibility aliases while
 * production assembly moves to the neutral names.
 */
export type ComputerUseDriverCommand = FakeDriverCommand
export type ComputerUseDriverConnection = FakeComputerUseDriverConnection

export interface FakeComputerUseSessionRuntime {
  open(session: ComputerUseSessionRef, signal: AbortSignal): Promise<FakeComputerUseDriverConnection>
  captureObserve(
    session: ComputerUseSessionRef,
    request: FakeCaptureRequest,
    options: Readonly<{ timeoutMs: number; signal: AbortSignal }>,
  ): Promise<DriverCallResult>
  close(session: ComputerUseSessionRef, reason: ComputerUseResetReason): Promise<void>
  /** Changing mode always tears down the old transport and invalidates its generation. */
  setPermissionMode(session: ComputerUseSessionRef, mode: ComputerUseDriverPermissionMode): Promise<void>
  permissionMode(session: ComputerUseSessionRef): ComputerUseDriverPermissionMode
  dispose(): Promise<void>
}

export type ComputerUseSessionRuntime = FakeComputerUseSessionRuntime
