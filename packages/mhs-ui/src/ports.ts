import type { JsonValue } from '@agnes/protocol'
import type { ClientContext, HomeEntry } from '@agnes/web-client'
import type { ComponentType } from 'react'

/** Presentation adapters only. The Host binds owner, profile, source and authority. */
export type Receipt =
  | { state: 'approval-required'; operationId: string; decisionId?: string }
  | { state: 'running'; operationId: string }
  | { state: 'completed'; operationId: string; output: JsonValue }
  | { state: 'refused' | 'cancelled' | 'unknown'; operationId: string; code: string }
/** Published Host facade; reads name both the declared service and its operation. */
export interface HostProfileServices {
  query(service: string, input: Record<string, unknown>): Promise<unknown>
  effect(service: string, input: Record<string, unknown>, options: { operationId: string }): Promise<unknown>
  readOperation(service: string, operationId: string): Promise<unknown>
}
export interface ProfileServices {
  query(name: string, input: JsonValue, options?: { signal?: AbortSignal }): Promise<unknown>
  effect(
    name: string,
    input: JsonValue,
    options: { operationId: string; signal?: AbortSignal },
  ): Promise<Receipt>
  readOperation(operationId: string): Promise<Receipt>
}
/** The installed module consumes the Host's authenticated lane facade directly. */
export type Streams = ClientContext['profile']['streams']
export type ClientStream = Awaited<ReturnType<Streams['open']>>
export interface HubStatus {
  state: 'starting' | 'ready' | 'stopping' | 'failed' | 'shutdown-unconfirmed'
  code?: string
  /** Public device SDK endpoints, never browser stream URLs or connection credentials. */
  endpoints?: { command: string; observation: string }
}
export interface DeveloperPort {
  status(signal: AbortSignal): Promise<HubStatus>
  retry(): Promise<void>
  /** Host-owned, reviewed configuration interface. No direct socket or arbitrary URL fetch. */
  configureExternal?(): Promise<void>
  check(
    device: string,
    signal: AbortSignal,
  ): Promise<readonly { name: string; state: 'passed' | 'failed' | 'unknown'; detail?: string }[]>
}
export interface ExampleView {
  id: string
  name: string
  description: string
  state: 'disabled' | 'starting' | 'running' | 'failed' | 'stopped' | 'unavailable' | 'installed'
  code?: string
  connected?: number
  total?: number
  /** Resolved local scene contribution. Never an arbitrary iframe or remote URL. */
  Scene?: ComponentType<{ onClose(): void }>
}
export interface ExamplesPort {
  list(signal: AbortSignal): Promise<readonly ExampleView[]>
  subscribe(listener: () => void): () => void
  /** Activation/launch retain native package review and bounded launch authorization. */
  inspect?(id: string): Promise<{ reviewId: string; presentation: unknown }>
  prepare?(id: string): Promise<{ launchTicket: string; presentation: unknown }>
  enable(id: string, reviewId?: string): Promise<void>
  stop(id: string): Promise<void>
  launch(id: string, launchTicket?: string): Promise<undefined | { sessionId: string }>
}
export interface MhsPorts {
  services: ProfileServices
  streams: Streams
  /** Public session service; changing sessions must clear the old device projection immediately. */
  session: Pick<ClientContext['session'], 'getSnapshot' | 'subscribe' | 'projection'>
  developer?: DeveloperPort
  examples?: ExamplesPort
  /** Optional service prefix resolved by the package's reviewed service declarations. */
  prefix?: string
}
export type MhsModuleContext = ClientContext & {
  profile: {
    services: HostProfileServices
    streams: Streams
    mhsDeveloper?: DeveloperPort
    mhsExamples?: ExamplesPort
  }
  homeEntries: { register(entry: HomeEntry & { placement: 'primary' }): () => void }
  availability: {
    getSnapshot(): { availability: string } | undefined
    subscribe(listener: () => void): () => void
  }
}
