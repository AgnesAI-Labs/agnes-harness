import { createReadStream } from 'node:fs'
import { connect } from 'node:net'
import { pathToFileURL } from 'node:url'
import { createTestHost } from '@agnes/host/testkit'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'
import { createWorkerServiceAuthority } from '../src/worker/service-authority.js'
import { servicePackageId, serviceRowId, serviceSnapshotId } from './service-row-fixture.js'

// Prevent worker/main.ts's executable auto-start; this fixture supplies a reviewed test Host while
// still exercising the real runWorker service-mode wire loop.
const env = { ...process.env }
delete process.env.AGNES_WORKER_TOKEN
const { runWorker } = await import('../src/worker/main.js')
const gateFd = Number(env.AGNES_GATE_FD ?? 3)
const gate = Number.isInteger(gateFd) && gateFd >= 0 ? createReadStream('', { fd: gateFd }) : null

void runWorker(
  env,
  {
    connect: (path) =>
      new Promise((resolve, reject) => {
        const socket = connect(path)
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      }),
    gate,
  },
  {
    buildHost: async (profile) => {
      const packageDirectory = `${profile.dataDir}/service-package`
      const source: RuntimePluginSnapshot = {
        snapshot: {
          snapshotId: serviceSnapshotId,
          profile: 'local-dev',
          packageId: servicePackageId,
          version: '1.0.0',
          integrity: serviceSnapshotId,
          treeIntegrity: hashDirectory(packageDirectory, { exclude: [] }),
          capabilityHash: 'fixture',
          directory: packageDirectory,
          contributions: [],
        },
        generation: 1,
        trusted: true,
      }
      const { host } = await createTestHost({
        dataDir: profile.dataDir,
        script: [],
        runtimePluginCatalogue: [source],
        extensionLoader: {
          import: async (file) => (await import(pathToFileURL(file).href)) as Record<string, unknown>,
        },
        profileInputs: {
          user: {
            name: 'local-dev',
            policy: { capabilityCeiling: ['services'] },
          },
        },
        serviceAuthority: createWorkerServiceAuthority(),
        seams: {
          principals: {
            resolve: async (credential) => ({
              id: (credential as { userId?: string }).userId ?? 'unknown',
              org: 'example',
              role: 'member',
              deptPath: [],
              attrs: {},
            }),
          },
        },
      })
      await host.applyRuntimeTarget(
        buildRuntimeTarget({
          rows: [
            createPluginRow({
              id: serviceRowId,
              plugin: `${servicePackageId}@${serviceSnapshotId}/main`,
              snapshotDigest: serviceSnapshotId,
              exportName: 'main',
              entryRevision: serviceSnapshotId,
              extrasRevision: 'none',
              mountRevision: 'service-worker-fixture:v1',
            }),
          ],
          resources: { mcp: [], skills: {} },
          resourceRevision: '0'.repeat(64),
          compositeRevision: '0'.repeat(64),
        }),
      )
      return host
    },
  },
).catch((error) => {
  console.error('fake service worker failed to start:', error)
  process.exit(1)
})
