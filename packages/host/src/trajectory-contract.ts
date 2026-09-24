import type { SessionRef } from '@agnes/extension-api'
import type { TrajectoryResolver } from './trajectory-network.js'

export type PrivacyTrajectoryCapability = {
  previous(session: SessionRef, signal: AbortSignal): Promise<string | null>
  upload(
    session: SessionRef,
    gate: {
      readonly active: boolean
      readonly consent: 'DISABLED' | 'LOCAL' | 'ANON' | 'FULL'
      readonly session: SessionRef
      send(value: unknown, sender: (bytes: Uint8Array) => void | Promise<void>): Promise<unknown>
    },
    authority: { assert(gate: unknown): void },
    signal: AbortSignal,
  ): Promise<void>
}

export type TrajectoryAssemblyOptions = {
  agnesVersion?: string
  trajectoryFetch?: typeof fetch
  trajectoryResolver?: TrajectoryResolver
}
