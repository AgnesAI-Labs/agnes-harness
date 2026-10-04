/** Durable runtime ownership. Registration generations are deliberately process-local. */
export interface RuntimeIdentity {
  readonly id: string
  readonly version: string
}

export type RuntimeOwner = RuntimeIdentity

/** Supported public operations; absence of a capability never selects another runtime. */
export interface RuntimeCapabilities {
  readonly prompt: boolean
  readonly cancel: boolean
  readonly resume: boolean
  readonly compact: boolean
  readonly fork: boolean
}

/** Public catalog entry supplied by trusted Host assembly. */
export interface RuntimeDescriptor extends RuntimeIdentity {
  readonly apiVersion: 1
  readonly label: string
  readonly available: boolean
  readonly unavailableReason?: string
  readonly capabilities: RuntimeCapabilities
}

/**
 * Lifecycle shared by existing Core sessions and additional runtime adapters.
 * Hosts compose their concrete command/read ports with this surface; implementations do not
 * expose Core state, a Cordis context, or the Host through this package.
 */
export interface RuntimeSession {
  readonly key: string
  readonly lastSeq: number
  readonly closingOrClosed: boolean
  /** Stop admission, cancel and drain work, then release owned resources and the writer. */
  close(): Promise<void>
}

/**
 * A runtime implementation with a Host-defined, capability-scoped opening context.
 * The context distinguishes create from resume and carries the already verified persisted owner.
 * open() publishes only a ready session and cleans up partially acquired resources on failure.
 */
export interface RuntimeFactory<OpenContext, Session extends RuntimeSession = RuntimeSession> {
  readonly descriptor: RuntimeDescriptor
  open(context: OpenContext): Promise<Session>
}

/** Registration ownership held by static assembly today and a trusted plugin loader in future. */
export interface RuntimeRegistration {
  readonly descriptor: RuntimeDescriptor
  readonly generation: number
  /** Synchronously refuse new acquisitions. Existing leases keep their exact factory. */
  retire(): void
  /** Resolves only after retirement and release of every admitted lease. */
  whenDrained(): Promise<void>
}

/**
 * One admitted session opening pinned to one factory generation. The Host releases on failed open
 * or after successful session.close(); release does not stop a session or perform cleanup itself.
 */
export interface RuntimeLease<OpenContext, Session extends RuntimeSession = RuntimeSession> {
  readonly descriptor: RuntimeDescriptor
  readonly generation: number
  /** Opens at most once, including when the opening fails. */
  open(context: OpenContext): Promise<Session>
  /** Idempotent. Refuses release while open() is still pending. */
  release(): void
}
