import type { ArtifactRef, SessionRef } from '@agnes/extension-api'
import type { ComputerUseRuntimePolicy } from './policy.js'
import type { ComputerUseArgs } from './schema.js'

export type ComputerUseTarget = Readonly<{
  app?: string
  pid?: number
  windowId?: number
  snapshotId?: string
}>

export type ComputerUseElement = Readonly<{
  index: number
  role: string
  label: string
  bounds: readonly [number, number, number, number] | null
  app?: string
  pid?: number
  windowId?: number
  elementToken?: string
}>

export type ComputerUseImage = Readonly<{
  ref: ArtifactRef
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
  digest: string
}>

export type ComputerUseCaptureResult = Readonly<{
  mode: 'som' | 'vision' | 'ax'
  width: number
  height: number
  app?: string
  windowTitle?: string
  target: ComputerUseTarget
  elements: readonly ComputerUseElement[]
  image?: ComputerUseImage
  note?: string
  boundsScale?: number
  safety?: Readonly<{
    reliable: boolean
    secureInput?: boolean
    payment?: boolean
    twoFactor?: boolean
    systemPermission?: boolean
  }>
}>

export type ComputerUseActionResult = Readonly<{
  ok: boolean
  action: string
  message?: string
  code?: string
  effect?: 'confirmed' | 'unverifiable' | 'suspected_noop'
  verified?: boolean
  escalation?: Readonly<{ recommended?: 'px' | 'foreground'; reason?: string }>
  path?: string
  degraded?: boolean
  deliveryMode?: 'background' | 'foreground'
  target?: ComputerUseTarget
}>

export type NormalizedComputerUseArgs = Omit<ComputerUseArgs, 'modifiers'> & {
  modifiers?: readonly ('cmd' | 'shift' | 'option' | 'ctrl' | 'fn' | 'win')[]
  /** Opaque capabilities from the current snapshot; never exposed in the model schema. */
  element_token?: string
  from_element_token?: string
  to_element_token?: string
  /** Exact sticky target for input dispatch; model-provided app never retargets an input action. */
  target?: ComputerUseTarget
}

export type ComputerUseBackend = Readonly<{
  profileHash: string
  generation: number
  /** Host-authored launch policy. Missing or malformed policy is refused before backend dispatch. */
  runtimePolicy: ComputerUseRuntimePolicy
  /** Production backends set this when input requires a fresh, reliable safety observation. */
  requiresReliableSafety?: true
  modifierActions: readonly ('click' | 'double_click' | 'right_click' | 'middle_click' | 'drag' | 'scroll')[]
  call(
    args: NormalizedComputerUseArgs,
    options: Readonly<{ session: SessionRef; signal: AbortSignal }>,
  ): Promise<unknown>
}>

export type ComputerUseBackendProvider = Readonly<{
  acquire(session: SessionRef, signal: AbortSignal): Promise<ComputerUseBackend>
  /** Host-owned lifecycle hooks; ordinary test providers may omit them. */
  release?(session: SessionRef): Promise<void>
  dispose?(): Promise<void>
}>
