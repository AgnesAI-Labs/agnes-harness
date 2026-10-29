import type { SurfaceDescriptor, SurfaceInstance, SurfaceServiceGrant } from '@agnes/protocol'
export type DeploymentPolicy = Readonly<{
  harnessVersion: string
  surfaceApiVersion: string
  grants: Readonly<Record<string, readonly SurfaceServiceGrant[]>>
}>
export type ResolvedDeployment = Readonly<{
  id: string
  version: string
  inventoryHash: string
  deploymentHash: string
  policyHash: string
  hash: string
  surfaces: readonly Readonly<{
    package: string
    version: string
    integrity: string
    descriptor: SurfaceDescriptor
    instance: SurfaceInstance
    services: readonly Readonly<{
      extension: string
      name: string
      version: string
      package: string
      integrity: string
    }>[]
  }>[]
}>
