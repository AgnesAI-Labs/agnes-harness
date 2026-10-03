import type {
  AssemblyGraph,
  CapabilityRequirement,
  ConfigResolveResult,
  DispatchAtomicDomain,
  MigrationPlan,
  MigrationReceipt,
  PackageResolverResolveResult,
  ReleasePlan,
  ReleaseSet,
} from '@agnes/protocol/runtime'
import { array, type FixtureContent, fields, readWire, requireRelease } from './primitives.js'

/** Detached public fixtures only. No deployment adapter currently supplies these observations. */
export interface LocatorRouteFixture {
  locatorId: string
  locatorRevision: number
  directoryEpoch: number
  routeId: string
  routeRevision: number | null
  releaseSetId: string | null
}
export interface ReleaseSetInputs {
  plan: ReleasePlan
  graph: AssemblyGraph
  configuration: ConfigResolveResult
  resolution: PackageResolverResolveResult
  fixture: {
    kind: 'public-fixture'
    now: string
    contents: FixtureContent[]
    previousRelease: ReleaseSet | null
    previousConfiguration: ConfigResolveResult | null
    directory: LocatorRouteFixture
    jointDomains: DispatchAtomicDomain[]
    migrations: {
      plan: MigrationPlan
      receipt: MigrationReceipt
      commit: {
        commitRef: string
        upgradeId: string
        planFingerprint: string
        directory: LocatorRouteFixture
      }
    }[]
    packagePermissions: { packageId: string; capabilities: CapabilityRequirement[] }[]
  }
}
export function readLocatorRoute(value: unknown): LocatorRouteFixture {
  const row = fields(
    value,
    ['locatorId', 'locatorRevision', 'directoryEpoch', 'routeId', 'routeRevision', 'releaseSetId'],
    '/fixture/directory',
  )
  return {
    locatorId: readWire('Id', row.locatorId),
    locatorRevision: readWire('UInt53', row.locatorRevision),
    directoryEpoch: readWire('UInt53', row.directoryEpoch),
    routeId: readWire('Id', row.routeId),
    routeRevision: row.routeRevision === null ? null : readWire('UInt53', row.routeRevision),
    releaseSetId: row.releaseSetId === null ? null : readWire('Id', row.releaseSetId),
  }
}
export function readInputs(value: unknown): ReleaseSetInputs {
  const root = fields(value, ['plan', 'graph', 'configuration', 'resolution', 'fixture'], '/')
  const f = fields(
    root.fixture,
    [
      'kind',
      'now',
      'contents',
      'previousRelease',
      'previousConfiguration',
      'directory',
      'jointDomains',
      'migrations',
      'packagePermissions',
    ],
    '/fixture',
  )
  requireRelease(f.kind === 'public-fixture', 'production_inputs_unavailable', '/fixture/kind')
  return {
    plan: readWire('ReleasePlan', root.plan),
    graph: readWire('AssemblyGraph', root.graph),
    configuration: readWire('ConfigResolveResult', root.configuration),
    resolution: readWire('PackageResolverResolveResult', root.resolution),
    fixture: {
      kind: 'public-fixture',
      now: readWire('Timestamp', f.now),
      contents: array(f.contents, '/fixture/contents').map((value) => {
        const content = fields(value, ['ref', 'value'], '/fixture/contents')
        return { ref: readWire('DataRef', content.ref), value: readWire('JsonValue', content.value) }
      }),
      previousRelease: f.previousRelease === null ? null : readWire('ReleaseSet', f.previousRelease),
      previousConfiguration:
        f.previousConfiguration === null ? null : readWire('ConfigResolveResult', f.previousConfiguration),
      directory: readLocatorRoute(f.directory),
      jointDomains: array(f.jointDomains, '/fixture/jointDomains').map((row) =>
        readWire('DispatchAtomicDomain', row),
      ),
      migrations: array(f.migrations, '/fixture/migrations').map((value) => {
        const row = fields(value, ['plan', 'receipt', 'commit'], '/fixture/migrations')
        const commit = fields(
          row.commit,
          ['commitRef', 'upgradeId', 'planFingerprint', 'directory'],
          '/fixture/migrations/commit',
        )
        return {
          plan: readWire('MigrationPlan', row.plan),
          receipt: readWire('MigrationReceipt', row.receipt),
          commit: {
            commitRef: readWire('Id', commit.commitRef),
            upgradeId: readWire('Id', commit.upgradeId),
            planFingerprint: readWire('Digest', commit.planFingerprint),
            directory: readLocatorRoute(commit.directory),
          },
        }
      }),
      packagePermissions: array(f.packagePermissions, '/fixture/packagePermissions').map((value) => {
        const row = fields(value, ['packageId', 'capabilities'], '/fixture/packagePermissions')
        return {
          packageId: readWire('Id', row.packageId),
          capabilities: array(row.capabilities, '/fixture/packagePermissions/capabilities').map(
            (capability) => readWire('CapabilityRequirement', capability),
          ),
        }
      }),
    },
  }
}
