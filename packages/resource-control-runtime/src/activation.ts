/**
 * The resource runtime only needs an atomic publication gate. Its permit is
 * deliberately opaque so this low-level package cannot depend on Host's gate.
 */
export type ResourceActivationPermit = unknown

export type ResourceActivationBarrier = Readonly<{
  quiesce<T>(operationId: string, publish: (permit: ResourceActivationPermit) => Promise<T>): Promise<T>
}>
