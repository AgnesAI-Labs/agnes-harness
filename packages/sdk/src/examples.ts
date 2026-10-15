import type { PluginMetadata } from '@agnes/protocol'

export type ExampleView = Readonly<{
  id: string
  version: string
  integrity: string
  metadata: PluginMetadata
  bundled: boolean
  installation: 'not-installed' | 'disabled' | 'enabling' | 'enabled' | 'failed'
}>
export type ExampleReview = Readonly<{
  reviewId: string
  integrity: string
  capabilityHash: string
  presentation: unknown
}>
export type ExampleOperation = Readonly<{
  state: 'running' | 'completed' | 'failed' | 'unknown'
  code?: string
  sessionId?: string
}>
export type ExampleRequest =
  | { action: 'list' }
  | { action: 'inspect'; exampleId: string }
  | { action: 'enable'; reviewId: string; operationId: string }
  | { action: 'read'; operationId: string }
  | { action: 'prepare'; exampleId: string; launchId: string }
  | { action: 'start'; launchTicket: string; operationId: string }

/** An authenticated transport supplied by the host, never a package-admin connection. */
export type ExampleTransport = (request: ExampleRequest) => Promise<unknown>
export interface ExamplePackages {
  list(): Promise<readonly ExampleView[]>
  inspect(exampleId: string): Promise<ExampleReview>
  enable(reviewId: string, operationId: string): Promise<{ operationId: string }>
  read(operationId: string): Promise<ExampleOperation>
}
export interface ExampleLaunches {
  prepare(exampleId: string, launchId: string): Promise<{ launchTicket: string; presentation: unknown }>
  start(launchTicket: string, operationId: string): Promise<{ sessionId: string }>
}

/** Browser and Node consumers use the same owner-bound, authenticated transport. */
export function createExampleClient(transport: ExampleTransport): {
  packages: ExamplePackages
  launches: ExampleLaunches
} {
  return {
    packages: {
      list: async () => (await transport({ action: 'list' })) as readonly ExampleView[],
      inspect: async (exampleId) => (await transport({ action: 'inspect', exampleId })) as ExampleReview,
      enable: async (reviewId, operationId) =>
        (await transport({ action: 'enable', reviewId, operationId })) as { operationId: string },
      read: async (operationId) => (await transport({ action: 'read', operationId })) as ExampleOperation,
    },
    launches: {
      prepare: async (exampleId, launchId) =>
        (await transport({ action: 'prepare', exampleId, launchId })) as {
          launchTicket: string
          presentation: unknown
        },
      start: async (launchTicket, operationId) =>
        (await transport({ action: 'start', launchTicket, operationId })) as { sessionId: string },
    },
  }
}
