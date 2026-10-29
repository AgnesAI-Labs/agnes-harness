import type { BundleLaunch, PluginMetadata } from '@agnes/protocol'

export type ExampleView = Readonly<{
  id: string
  version: string
  integrity: string
  metadata: PluginMetadata
  bundled: boolean
  runtime?: { state: 'starting' | 'running' | 'failed' | 'stopped' | 'unavailable'; code?: string }
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
  draft?: BundleLaunch['prompt']
}>
export type ExampleRequest =
  | { action: 'list' }
  | { action: 'stop'; exampleId: string; operationId: string }
  | { action: 'inspect'; exampleId: string }
  | { action: 'inspect-remove'; exampleId: string }
  | { action: 'remove'; reviewId: string; operationId: string }
  | { action: 'enable'; reviewId: string; operationId: string }
  | { action: 'read'; operationId: string }
  | { action: 'prepare'; exampleId: string; launchId: string }
  | { action: 'start'; launchTicket: string; operationId: string }

/** An authenticated transport supplied by the host, never a package-admin connection. */
export type ExampleTransport = (request: ExampleRequest) => Promise<unknown>
export interface ExamplePackages {
  list(): Promise<readonly ExampleView[]>
  stop(exampleId: string, operationId: string): Promise<void>
  inspectRemove(exampleId: string): Promise<ExampleReview>
  remove(reviewId: string, operationId: string): Promise<{ operationId: string }>
  inspect(exampleId: string): Promise<ExampleReview>
  enable(reviewId: string, operationId: string): Promise<{ operationId: string }>
  read(operationId: string): Promise<ExampleOperation>
}
export interface ExampleLaunches {
  prepare(exampleId: string, launchId: string): Promise<{ launchTicket: string; presentation: unknown }>
  start(
    launchTicket: string,
    operationId: string,
  ): Promise<{ sessionId: string; draft?: BundleLaunch['prompt'] }>
}

/** Browser and Node consumers use the same owner-bound, authenticated transport. */
export function createExampleClient(transport: ExampleTransport): {
  packages: ExamplePackages
  launches: ExampleLaunches
} {
  return {
    packages: {
      list: async () => (await transport({ action: 'list' })) as readonly ExampleView[],
      stop: async (exampleId, operationId) => {
        await transport({ action: 'stop', exampleId, operationId })
      },
      inspectRemove: async (exampleId) =>
        (await transport({ action: 'inspect-remove', exampleId })) as ExampleReview,
      remove: async (reviewId, operationId) =>
        (await transport({ action: 'remove', reviewId, operationId })) as { operationId: string },
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
        (await transport({ action: 'start', launchTicket, operationId })) as {
          sessionId: string
          draft?: BundleLaunch['prompt']
        },
    },
  }
}
