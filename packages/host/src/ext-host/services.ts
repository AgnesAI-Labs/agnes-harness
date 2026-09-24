import { OwnedRegistryTable } from '@agnes/core'
import {
  checkServiceDef,
  ExtensionError,
  type ExtensionManifest,
  type ServiceDef,
} from '@agnes/extension-api'
import { inspectJsonData, type JsonValue, jcs, type ServiceCapability } from '@agnes/protocol'
import { frozenJson } from './frozen-json.js'
import { compileExtensionSchema } from './json-schema.js'
import type { Lease } from './lease.js'

export type ServiceRegistration = Readonly<{
  owner: string
  version: string
  capability: ServiceCapability
  manifest: ExtensionManifest
  handler: ServiceDef['handler']
  input(value: unknown): boolean
  output(value: unknown): boolean
  assertAlive(): void
  assertRunning(): void
  consume(): void
  signal: AbortSignal
}>

/** Host owns registrations; authors receive only an identity-checked disposer. */
export class ServiceRegistry {
  private readonly entries = new OwnedRegistryTable<ServiceRegistration>(true)

  /** Register a verified Cordis row without accepting a package-authored extension manifest. */
  registerRow(
    def: ServiceDef,
    authority: Readonly<{
      owner: string
      version: string
      signal: AbortSignal
      assertAlive(): void
      assertRunning(): void
      consume(): void
    }>,
  ) {
    if (!checkServiceDef(def).ok) throw new ExtensionError('E_SERVICE_DEF', 'invalid service definition')
    if (!/^plugin\/[0-9a-f]{16}$/.test(authority.owner) || !/^\d+\.\d+\.\d+/.test(authority.version))
      throw new ExtensionError('E_SERVICE_DEF', 'invalid row service identity')
    const { handler, ...metadata } = def
    const snapshot = inspectJsonData(metadata)
    if (!snapshot.ok) throw new ExtensionError('E_SERVICE_DEF', 'invalid service capability')
    const capability = frozenJson(snapshot.value) as ServiceCapability
    const manifest = Object.freeze({
      id: authority.owner,
      version: authority.version,
      apiRange: '*',
      entry: './index.js',
      capabilities: Object.freeze({ services: Object.freeze([capability]) }),
    }) as ExtensionManifest
    const assertAlive = () => {
      authority.assertAlive()
      if (authority.signal.aborted) throw new ExtensionError('E_LEASE_EXPIRED', 'service row is closed')
    }
    assertAlive()
    const registration: ServiceRegistration = Object.freeze({
      owner: authority.owner,
      version: authority.version,
      capability,
      manifest,
      handler: handler.bind(def),
      input: compileExtensionSchema(capability.inputSchema, 'E_SERVICE_DEF'),
      output: compileExtensionSchema(capability.outputSchema, 'E_SERVICE_DEF'),
      assertAlive,
      assertRunning: () => {
        authority.assertRunning()
        if (authority.signal.aborted) throw new ExtensionError('E_LEASE_EXPIRED', 'service row is closed')
      },
      consume: () => authority.consume(),
      signal: authority.signal,
    })
    const key = `${authority.owner}/${capability.name}`
    if (this.entries.get(key)) throw new ExtensionError('E_REGISTRY_DUPLICATE', 'service already registered')
    return this.entries.add(authority.owner, key, registration)
  }

  register(def: ServiceDef, authority: { manifest: ExtensionManifest; lease: Lease; signal: AbortSignal }) {
    const { manifest, lease, signal } = authority
    if (!checkServiceDef(def).ok) throw new ExtensionError('E_SERVICE_DEF', 'invalid service definition')
    const cap = manifest.capabilities.services?.find((item) => item.name === def.name)
    const { handler, ...metadata } = def
    if (!cap || jcs(metadata as unknown as JsonValue) !== jcs(cap as unknown as JsonValue))
      throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'service differs from manifest')
    const snapshot = inspectJsonData(manifest)
    if (!snapshot.ok) throw new ExtensionError('E_SERVICE_DEF', 'invalid service manifest')
    const frozenManifest = frozenJson(snapshot.value) as ExtensionManifest
    const capability = frozenManifest.capabilities.services?.find((item) => item.name === def.name)
    if (!capability) throw new ExtensionError('E_SERVICE_DEF', 'invalid service capability')
    const assertAlive = () => {
      lease.assertAlive('execute')
      if (signal.aborted || !lease.allows('service', capability.name))
        throw new ExtensionError('E_CAPABILITY_UNDECLARED', 'service lease unavailable')
    }
    assertAlive()
    const registration: ServiceRegistration = Object.freeze({
      owner: manifest.id,
      version: manifest.version,
      capability,
      manifest: frozenManifest,
      handler: handler.bind(def),
      input: compileExtensionSchema(capability.inputSchema, 'E_SERVICE_DEF'),
      output: compileExtensionSchema(capability.outputSchema, 'E_SERVICE_DEF'),
      assertAlive,
      assertRunning: () => {
        lease.assertInvocationAlive()
        if (signal.aborted) throw new ExtensionError('E_LEASE_EXPIRED', 'service is closed')
      },
      consume: () => lease.consume(),
      signal,
    })
    const key = `${manifest.id}/${capability.name}`
    if (this.entries.get(key)) throw new ExtensionError('E_REGISTRY_DUPLICATE', 'service already registered')
    return this.entries.add(manifest.id, key, registration)
  }

  resolve(extension: string, name: string): ServiceRegistration | undefined {
    return this.entries.get(`${extension}/${name}`)
  }

  registrations(owner: string): string[] {
    return this.entries
      .values()
      .filter((entry) => entry.owner === owner)
      .map((entry) => `service:${entry.owner}/${entry.capability.name}`)
      .sort()
  }

  purgeOwner(owner: string): void {
    this.entries.purgeOwner(owner)
  }
}
